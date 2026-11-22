// Git history for rigup changes (and rigup update's "what changed").
//
// Claude Code's marketplace clones are shallow (one commit), so they have no history. For repo
// sources rigup keeps its own bare, blobless clone in <cache>/<source> (a few MB, blobs fetched
// only when a description is read), which it owns and refreshes freely. Local folders that are
// inside a git repo use that repo, read-only: rigup never fetches, resets or checks out there.

import path from 'node:path';
import { CATALOG_PATH, GIT_ENV } from './constants.mjs';
import { classifyChanges, parseNameStatus } from './changes.mjs';
import { frontmatterDescription, shortDescription } from './frontmatter.mjs';
import { parseJson } from './parse.mjs';
import { gitUrls, slugify } from './sources.mjs';

const git = (ctx, dir, args, timeout = 120000) => ctx.run('git', ['-C', dir, ...args], { timeout, env: GIT_ENV });

/** Cache folder of a repo source. */
export function cacheDirFor(ctx, spec) {
  return path.join(ctx.cacheDir, 'history', slugify(spec.id));
}

/**
 * Where a source's history is: { dir, head, prefix } (prefix = the source folder inside the repo,
 * '' for repo sources), or throws with a readable reason. Clones or refreshes the cache for repos.
 */
export function openHistory(ctx, s) {
  if (s.kind === 'remote') {
    const dir = cacheDirFor(ctx, s.spec);
    const ref = s.spec.ref ? `refs/heads/${s.spec.ref}` : 'HEAD';
    if (ctx.readFile(path.join(dir, 'HEAD')) === null) {
      const cloned = gitUrls(s.spec).some(url => ctx.run('git', ['clone', '-q', '--bare', '--filter=blob:none', '--no-tags', url, dir], { timeout: 300000, env: GIT_ENV }).status === 0);
      if (!cloned) throw new Error('cannot clone it without a prompt (rigup doctor)');
    } else {
      const fetch = git(ctx, dir, ['fetch', '-q', '--no-tags', '--filter=blob:none', 'origin', '+refs/heads/*:refs/heads/*']);
      if (fetch.status !== 0) throw new Error(`cannot refresh its history: ${fetch.stderr.trim() || 'git fetch failed'}`);
    }
    const head = git(ctx, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (head.status !== 0) throw new Error(`no ${s.spec.ref || 'default'} branch`);
    return { dir, head: head.stdout.trim(), prefix: '' };
  }
  if (s.kind === 'marketplace' || s.kind === 'plugin' || s.kind === 'flat') {
    const top = git(ctx, s.spec.path, ['rev-parse', '--show-toplevel'], 10000);
    if (top.status !== 0) throw new Error('not in a git repo, so there is no history');
    const dir = top.stdout.trim();
    const head = git(ctx, dir, ['rev-parse', 'HEAD'], 10000);
    if (head.status !== 0) throw new Error('the repo has no commits yet');
    // realpath-style comparison: macOS /tmp vs /private/tmp, symlinked homes.
    const real = git(ctx, s.spec.path, ['rev-parse', '--show-prefix'], 10000);
    const prefix = real.status === 0 ? real.stdout.trim().replace(/\/$/, '') : path.relative(dir, s.spec.path);
    return { dir, head: head.stdout.trim(), prefix };
  }
  throw new Error(s.kind === 'missing' ? 'folder not found' : 'nothing in it');
}

/**
 * Where each wanted plugin lives in the repo at `commit`, as roots for componentOf.
 * Marketplaces: from the catalog's ./ sources. Plugin and flat folders: the folder itself.
 */
export function rootsAt(ctx, s, hist, commit) {
  // posix join, then drop a leading "./" (never the dot of ".claude-plugin") and a trailing "/".
  const join = (...parts) => {
    const joined = path.posix.join(...parts.filter(Boolean)).replace(/^\.\//, '').replace(/\/$/, '');
    return joined === '.' ? '' : joined;
  };
  if (s.kind === 'plugin') return [{ prefix: hist.prefix, plugin: s.pluginName }];
  if (s.kind === 'flat') return [{ prefix: hist.prefix, plugin: s.pluginName, flat: true }];
  const show = git(ctx, hist.dir, ['show', `${commit}:${join(hist.prefix, CATALOG_PATH)}`]);
  const catalog = show.status === 0 ? parseJson(show.stdout) : null;
  if (!catalog) return [];
  const pluginRoot = (catalog.metadata && catalog.metadata.pluginRoot) || '';
  const wanted = s.selection === '*' ? null : new Set(s.selection);
  return (catalog.plugins || [])
    .filter(p => typeof p.source === 'string' && (!wanted || wanted.has(p.name)))
    .map(p => ({ prefix: join(hist.prefix, p.source.startsWith('.') ? p.source : join(pluginRoot, p.source)), plugin: p.name }));
}

/**
 * Resolves a window bound to a commit reachable from `head`:
 *   "7d" / "2w"     -> last commit before that many days/weeks ago
 *   "YYYY-MM-DD"    -> last commit before the start of that day (endOfDay: before the next day)
 *   anything else   -> a commit-ish (sha, tag, ref)
 */
export function resolveBound(ctx, dir, head, spec, { endOfDay = false } = {}) {
  let m = /^(\d+)([dw])$/.exec(spec);
  if (m) {
    const days = Number(m[1]) * (m[2] === 'w' ? 7 : 1);
    return git(ctx, dir, ['rev-list', '-1', `--before=${days} days ago`, head]).stdout.trim() || null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec);
  if (m) {
    const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (endOfDay ? 1 : 0)));
    return git(ctx, dir, ['rev-list', '-1', `--before=${day.toISOString().slice(0, 10)} 00:00`, head]).stdout.trim() || null;
  }
  const res = git(ctx, dir, ['rev-parse', '--verify', '--quiet', `${spec}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** First commit of the history (when the window starts before it). */
export function rootCommit(ctx, dir, head) {
  const res = git(ctx, dir, ['rev-list', '--max-parents=0', head]);
  return res.status === 0 ? res.stdout.trim().split('\n').pop() : null;
}

/** Changes between two commits for one source, with descriptions. */
export function computeChanges(ctx, s, hist, base, head) {
  const roots = [...rootsAt(ctx, s, hist, head), ...rootsAt(ctx, s, hist, base)]
    .filter((r, i, all) => all.findIndex(x => x.prefix === r.prefix) === i);
  if (!roots.length) return [];
  const diff = git(ctx, hist.dir, ['diff', '--name-status', '-M', base, head, '--', ...new Set(roots.map(r => r.prefix || '.'))]);
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const kept = [];
  for (const it of classifyChanges(parseNameStatus(diff.stdout), roots)) {
    // Read the main file where it exists (head, or base for a removed one). A "skill" folder with
    // no SKILL.md at either commit (e.g. skills/_shared/) is not a skill: drop it.
    const [first, second] = it.status === 'removed' ? [base, head] : [head, base];
    let show = git(ctx, hist.dir, ['show', `${first}:${it.rel}`]);
    if (show.status !== 0) show = git(ctx, hist.dir, ['show', `${second}:${it.rel}`]);
    if (show.status !== 0) continue;
    const { rel, fromRel, ...item } = it;
    kept.push({ ...item, description: shortDescription(frontmatterDescription(show.stdout)) });
  }
  return kept;
}
