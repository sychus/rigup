// rigup update: rigup itself, every source, every plugin, then what changed. One command.

import path from 'node:path';
import { GIT_ENV, LOCAL_MARKETPLACE } from './constants.mjs';
import { gatherFacts } from './facts.mjs';
import { localEntries, writeLocalMarketplace } from './local-marketplace.mjs';
import { compareVersions, parseCliJson, parseJson, parseLsRemote, shortSha } from './parse.mjs';
import { formatChanges } from './changes.mjs';
import { computeChanges, openHistory } from './history.mjs';

// The npm package name (scoped: npm rejected plain "rigup" as too close to "rig-up").
// The command stays `rigup`. Everything below derives from this one constant.
export const PACKAGE = '@sychusdev/rigup';
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const LOCK_RE = new RegExp(`(?:^|\\n)\\s*'?${escapeRe(PACKAGE)}@[^\\n]*\\n\\s*resolution: \\{commit: ([0-9a-f]{40})`);

/** True for a pnpm git spec ("github:o/r", "git+https://…", "o/r#ref"); false for a registry range. */
export function isGitSpec(spec) {
  return /^(github:|gitlab:|bitbucket:|git\+|git:|https?:\/\/|ssh:\/\/|git@)/.test(spec) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec);
}

/** Repo URLs and ref of a git spec ("github:o/r#dev" -> { urls, ref: 'dev' }). */
export function gitSpecTarget(spec) {
  const [base, hash = ''] = spec.split('#');
  const ref = hash.split('&').find(part => part && !part.startsWith('path:')) || null;
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(base);
  if (short) return { urls: [`git@github.com:${short[1]}/${short[2]}.git`, `https://github.com/${short[1]}/${short[2]}.git`], ref };
  return { urls: [base.replace(/^git\+/, '')], ref };
}

/** Commit rigup was installed at, from the pnpm lockfile next to the global package.json. */
export function lockCommit(lockText) {
  const m = LOCK_RE.exec(lockText || '');
  return m ? m[1] : null;
}

/**
 * How rigup was installed: walks up from its own folder to the pnpm global project whose
 * package.json depends on rigup. Returns { spec, commit } or null (run from a checkout, npx…).
 */
export function findInstall(ctx) {
  let dir = ctx.appDir;
  for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i++) {
    dir = path.dirname(dir);
    const pkg = parseJson(ctx.readFile(path.join(dir, 'package.json')));
    const spec = pkg && pkg.dependencies && pkg.dependencies[PACKAGE];
    if (typeof spec === 'string') return { spec, commit: lockCommit(ctx.readFile(path.join(dir, 'pnpm-lock.yaml'))) };
  }
  return null;
}

/** rigup's own version, from its package.json. */
export function ownVersion(ctx) {
  const pkg = parseJson(ctx.readFile(path.join(ctx.appDir, 'package.json')));
  return (pkg && pkg.version) || null;
}

/** Step 1: update rigup itself. Returns { status: ok|info|fail, text, detail?, changed }. */
export function updateSelf(ctx) {
  const install = findInstall(ctx);
  if (!install) return { status: 'info', text: 'rigup is not a pnpm global install (a checkout or npx): skipped updating it', changed: false };

  if (isGitSpec(install.spec)) {
    const { urls, ref } = gitSpecTarget(install.spec);
    let latest = null;
    for (const url of urls) {
      const res = ctx.run('git', ['ls-remote', url, ref ? `refs/heads/${ref}` : 'HEAD'], { timeout: 20000, env: GIT_ENV });
      latest = res.status === 0 ? parseLsRemote(res.stdout) : null;
      if (latest) break;
    }
    if (latest && install.commit === latest) return { status: 'ok', text: `rigup is up to date (${shortSha(latest)})`, changed: false };
    const res = ctx.run('pnpm', ['add', '-g', install.spec], { timeout: 300000 });
    if (res.status !== 0) return { status: 'fail', text: 'could not update rigup', detail: `pnpm add -g "${install.spec}"`, changed: false };
    return { status: 'ok', text: `rigup ${shortSha(install.commit)} → ${shortSha(latest)}`, changed: true };
  }

  const current = ownVersion(ctx);
  const view = ctx.run('npm', ['view', PACKAGE, 'version'], { timeout: 30000 });
  const latest = view.status === 0 ? view.stdout.trim() : null;
  if (!latest) return { status: 'info', text: `could not check the latest rigup version (npm view ${PACKAGE} version)`, changed: false };
  if (current && compareVersions(latest, current) <= 0) return { status: 'ok', text: `rigup ${current} is the latest`, changed: false };
  const res = ctx.run('pnpm', ['add', '-g', `${PACKAGE}@latest`], { timeout: 300000 });
  if (res.status !== 0) return { status: 'fail', text: 'could not update rigup', detail: `pnpm add -g ${PACKAGE}@latest`, changed: false };
  return { status: 'ok', text: `rigup ${current || '?'} → ${latest}`, changed: true };
}

const marketplaceHead = (ctx, m) => {
  if (!m || !m.installLocation) return null;
  const res = ctx.run('git', ['-C', m.installLocation, 'rev-parse', 'HEAD'], { timeout: 10000 });
  return res.status === 0 ? res.stdout.trim() : null;
};

/** Runs rigup update and prints each step as it happens. Returns the exit code. */
export function runUpdate(ctx, { color = false, log = console.log } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const step = (status, text, detail) => {
    log(`  ${{ ok: paint(32, '✔'), fail: paint(31, '✖'), info: paint(36, 'ℹ') }[status]} ${text}`);
    if (detail) log(paint(2, `      ${detail}`));
  };
  let failed = false;
  let changed = false;
  log('rigup update\n');

  // 1. rigup itself (the new version runs from the next command on).
  const self = updateSelf(ctx);
  step(self.status, self.text, self.detail);
  failed = failed || self.status === 'fail';
  changed = changed || self.changed;

  const facts = gatherFacts(ctx, { checkAccess: false });
  if (!facts.claude.installed) {
    step('fail', 'claude is not installed', 'install Claude Code: https://code.claude.com/docs');
    return 1;
  }
  if (facts.config.errors.length || !facts.sources.length) {
    step('fail', facts.config.errors[0] || 'no sources yet', facts.config.errors.length ? 'rigup doctor' : 'rigup add <source>');
    return 1;
  }

  // 2. Sources: refresh every registered marketplace, and rebuild rigup-local from the folders.
  const moved = [];
  for (const s of facts.sources.filter(x => (x.kind === 'remote' || x.kind === 'marketplace') && x.marketplace)) {
    const before = marketplaceHead(ctx, s.marketplace);
    const res = ctx.run('claude', ['plugin', 'marketplace', 'update', s.marketplace.name, '--json'], { timeout: 180000 });
    if (res.status !== 0) {
      step('fail', `could not refresh ${s.label}`, `claude plugin marketplace update ${s.marketplace.name}`);
      failed = true;
      continue;
    }
    const after = marketplaceHead(ctx, s.marketplace);
    if (before && after && before !== after) {
      step('ok', `${s.label} ${shortSha(before)} → ${shortSha(after)}`);
      moved.push({ source: s, before, after });
    } else {
      step('ok', `${s.label} is up to date${after ? ` (${shortSha(after)})` : ''}`);
    }
  }
  const unregistered = facts.sources.filter(x => (x.kind === 'remote' || x.kind === 'marketplace') && !x.marketplace);
  if (unregistered.length) step('info', `not registered yet: ${unregistered.map(s => s.label).join(', ')}`, 'rigup setup');

  const entries = localEntries(facts);
  const lm = facts.localMarketplace;
  if (entries.length && lm.registered) {
    try {
      writeLocalMarketplace(ctx, lm.dir, entries);
      const res = ctx.run('claude', ['plugin', 'marketplace', 'update', LOCAL_MARKETPLACE, '--json'], { timeout: 180000 });
      if (res.status !== 0) throw new Error(`claude plugin marketplace update ${LOCAL_MARKETPLACE}`);
      step('ok', `${LOCAL_MARKETPLACE} rebuilt from ${entries.length} local folder${entries.length === 1 ? '' : 's'}`);
    } catch (err) {
      step('fail', `could not rebuild ${LOCAL_MARKETPLACE}`, err.message);
      failed = true;
    }
  }

  // 3. Plugins, one by one (Claude Code has no bulk update). Local ones are refreshed only when
  //    their folder changed since the installed copy, since a local plugin has no version.
  const updated = [];
  const managed = [];
  let total = 0;
  for (const s of facts.sources) {
    for (const p of s.installed) {
      const name = p.id.split('@')[0];
      total++;
      if (s.pluginName) {
        const synced = Date.parse(p.lastUpdated || p.installedAt || '');
        if (!(s.newestMtime && synced && s.newestMtime > synced)) continue;
      }
      const res = ctx.run('claude', ['plugin', 'update', p.id, '--json'], { timeout: 180000 });
      const out = parseCliJson(res.stdout) || {};
      if (res.status === 0 && (s.pluginName || (out.updateOutcome !== 'up_to_date' && out.oldVersion !== out.newVersion))) updated.push(name);
      else if (res.status !== 0 && p.scope === 'managed') managed.push(name);
      else if (res.status !== 0) {
        step('fail', `could not update ${name}`, `claude plugin update ${p.id}`);
        failed = true;
      }
    }
  }
  if (updated.length) {
    step('ok', `updated: ${updated.join(', ')} (${updated.length} plugin${updated.length === 1 ? '' : 's'})`);
    changed = true;
  } else {
    step('ok', `plugins are up to date (${total})`);
  }
  if (managed.length) step('info', `left to your organization's managed settings: ${managed.join(', ')}`);

  // 4. What changed in the sources that moved, from the same engine as rigup changes.
  const results = [];
  for (const { source, before, after } of moved) {
    try {
      results.push({ source: source.label, base: before, head: after, items: computeChanges(ctx, source, openHistory(ctx, source), before, after) });
    } catch (err) {
      results.push({ source: source.label, skipped: `could not list what changed: ${err.message}` });
    }
  }
  if (results.length) {
    log('');
    log(formatChanges(results, { title: 'What changed', color }));
  }

  if (changed) log('\nRestart open Claude sessions to use the new versions.');
  return failed ? 1 : 0;
}
