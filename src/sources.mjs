// Sources: where your skills, agents and commands live. Pure functions only.
//
// A source is one of:
//   github  owner/repo[@ref] (or github:owner/repo[@ref])   a repo that is a Claude Code marketplace
//   git     https://… / git@…:….git / ssh://…               same, any git host
//   local   /path, ./path, ~/path                            a folder on this machine, which is
//           a marketplace (.claude-plugin/marketplace.json), a plugin (skills/, agents/,
//           commands/ or .claude-plugin/plugin.json) or a flat folder of skills (<name>/SKILL.md)

import path from 'node:path';

const GITHUB_RE = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@([^\s@]+))?$/;
const GIT_URL_RE = /^(?:https?:\/\/|ssh:\/\/|git@[^:]+:)/;

/**
 * Parses what the user typed after `rigup add` into a source.
 * Returns { type, id, ... } or { error }.
 */
export function parseSpec(raw, { home = '', cwd = '' } = {}) {
  const spec = String(raw || '').trim();
  if (!spec) return { error: 'empty source' };

  if (spec === '~' || spec.startsWith('~/') || spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec === '.') {
    const expanded = spec === '~' || spec.startsWith('~/') ? path.join(home, spec.slice(1)) : spec;
    const abs = path.resolve(cwd, expanded);
    return { type: 'local', id: abs, path: abs };
  }
  if (GIT_URL_RE.test(spec)) {
    const [url, ref] = spec.split('#');
    return { type: 'git', id: ref ? `${url}#${ref}` : url, url, ref: ref || null };
  }
  const m = GITHUB_RE.exec(spec);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    return { type: 'github', id: m[3] ? `${repo}@${m[3]}` : repo, repo, ref: m[3] || null };
  }
  return { error: `cannot tell what "${spec}" is: use owner/repo, a git URL or a folder path (./, ../, / or ~/)` };
}

/** The argument `claude plugin marketplace add` takes for a remote or local-marketplace source. */
export function marketplaceAddArg(source) {
  if (source.type === 'github') return source.ref ? `${source.repo}@${source.ref}` : source.repo;
  if (source.type === 'git') return source.ref ? `${source.url}#${source.ref}` : source.url;
  return source.path;
}

/**
 * The marketplace as declared in settings (extraKnownMarketplaces), or null for a local folder.
 * Claude Code ignores an entry without its source, autoUpdate included.
 */
export function marketplaceSource(source) {
  if (source.type === 'github') return { source: 'github', repo: source.repo, ...(source.ref ? { ref: source.ref } : {}) };
  if (source.type === 'git') return { source: 'git', url: source.url, ...(source.ref ? { ref: source.ref } : {}) };
  return null;
}

/** git URLs to try, without prompts, for a remote source (SSH first, like Claude Code). */
export function gitUrls(source) {
  if (source.type === 'github') return [`git@github.com:${source.repo}.git`, `https://github.com/${source.repo}.git`];
  if (source.type === 'git') return [source.url];
  return [];
}

const normUrl = url => String(url || '').toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');

/**
 * The registered marketplace (from `claude plugin marketplace list --json`) that a source is,
 * or null. Local plugin and flat folders are not marketplaces: they live in rigup-local.
 */
export function matchMarketplace(source, marketplaces) {
  const list = Array.isArray(marketplaces) ? marketplaces : [];
  if (source.type === 'github') {
    return list.find(m => m.source === 'github' && String(m.repo || '').toLowerCase() === source.repo.toLowerCase()) || null;
  }
  if (source.type === 'git') {
    return list.find(m => m.source === 'git' && normUrl(m.url) === normUrl(source.url)) || null;
  }
  return list.find(m => m.source === 'directory' && path.resolve(m.path || '') === source.path) || null;
}

/**
 * What a local folder is, from its file listing:
 *   marketplace | plugin | flat | empty | missing
 * `has(rel)` says whether a path exists under the folder; `children` lists its entries and
 * `childHas(name, rel)` checks inside one of them.
 */
export function classifyLocal({ exists, has, children = [], childHas }) {
  if (!exists) return 'missing';
  if (has('.claude-plugin/marketplace.json')) return 'marketplace';
  if (has('.claude-plugin/plugin.json') || has('skills') || has('agents') || has('commands')) return 'plugin';
  if (children.some(name => !name.startsWith('.') && childHas(name, 'SKILL.md'))) return 'flat';
  return 'empty';
}

/** A plugin name Claude Code accepts, from a folder name (kebab-case, a-z 0-9). */
export function slugify(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'skills';
}

/** Short label for a source in reports. */
export function label(source, home = '') {
  if (source.type === 'local' && home && source.path.startsWith(`${home}/`)) return `~${source.path.slice(home.length)}`;
  return source.id;
}
