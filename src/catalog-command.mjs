// `rigup list` and `rigup search`: read every skill, agent and command of the wanted plugins from
// where they live on this machine:
//   repos and local marketplaces  the marketplace folder Claude Code keeps (installLocation)
//   local plugin folders          the folder itself
//   local skills folders          the folder itself (<skill>/SKILL.md)
// Plugins whose catalog entry points outside the marketplace repo (git-subdir, url…) cannot be
// read before they are installed, so they are listed as a note instead.

import path from 'node:path';
import { COMPONENT_DIRS, PLUGIN_MANIFEST_PATH } from './constants.mjs';
import { gatherFacts } from './facts.mjs';
import { body, frontmatterDescription, shortDescription } from './frontmatter.mjs';
import { parseJson } from './parse.mjs';
import { formatList, formatSearch, searchCatalog, sortEntries } from './catalog.mjs';

const BODY_LIMIT = 60000;
const KIND = { skills: 'skill', agents: 'agent', commands: 'command' };

/** Folder of each component kind for a plugin, honoring path overrides in plugin.json. */
export function componentDirs(ctx, pluginDir) {
  const manifest = parseJson(ctx.readFile(path.join(pluginDir, PLUGIN_MANIFEST_PATH))) || {};
  const dirs = [];
  for (const kind of COMPONENT_DIRS) {
    const custom = [].concat(manifest[kind] || []).filter(p => typeof p === 'string');
    for (const rel of [kind, ...custom]) {
      const dir = path.resolve(pluginDir, rel);
      if (!dirs.some(d => d.dir === dir)) dirs.push({ kind: KIND[kind], dir });
    }
  }
  return dirs;
}

/** Main files of a plugin: skills/<name>/SKILL.md, agents/<name>.md, commands/<name>.md. */
export function scanPlugin(ctx, pluginDir, { flat = false } = {}) {
  const dirs = flat ? [{ kind: 'skill', dir: pluginDir }] : componentDirs(ctx, pluginDir);
  const found = [];
  for (const { kind, dir } of dirs) {
    for (const name of ctx.listDir(dir) || []) {
      if (name.startsWith('.')) continue;
      if (kind === 'skill') {
        const file = path.join(dir, name, 'SKILL.md');
        if (ctx.stat(file)) found.push({ kind, name, file });
      } else if (name.endsWith('.md')) {
        found.push({ kind, name: name.slice(0, -3), file: path.join(dir, name) });
      }
    }
  }
  return found;
}

function entry(ctx, { source, plugin, pluginId, kind, name, file }) {
  const text = ctx.readFile(file) || '';
  const description = frontmatterDescription(text) || '';
  return { source, plugin, pluginId, kind, name, description, short: shortDescription(description), body: body(text).slice(0, BODY_LIMIT) };
}

/** Folder of a catalog plugin inside its marketplace, or null when it lives elsewhere. */
export function pluginFolder(root, catalog, plugin) {
  if (typeof plugin.source !== 'string') return null;
  const pluginRoot = (catalog.metadata && catalog.metadata.pluginRoot) || '';
  const rel = plugin.source.startsWith('./') || plugin.source.startsWith('../') ? plugin.source : path.join(pluginRoot, plugin.source);
  return path.resolve(root, rel);
}

/** Every entry of the wanted plugins of every source, plus notes about what could not be read. */
export function loadCatalog(ctx, facts = gatherFacts(ctx, { checkAccess: false })) {
  const entries = [];
  const notes = [];
  for (const s of facts.sources) {
    const add = (plugin, pluginDir, opts) => {
      const pluginId = `${plugin}@${s.marketplaceName}`;
      for (const c of scanPlugin(ctx, pluginDir, opts)) entries.push(entry(ctx, { source: s.label, plugin, pluginId, ...c }));
    };
    if (s.kind === 'plugin' || s.kind === 'flat') {
      add(s.pluginName, s.spec.path, { flat: s.kind === 'flat' });
      continue;
    }
    if (s.kind === 'missing' || s.kind === 'empty') {
      notes.push(`${s.label}: ${s.kind === 'missing' ? 'folder not found' : 'nothing in it'} (rigup doctor)`);
      continue;
    }
    if (!s.catalog) {
      notes.push(`${s.label}: not registered yet, nothing to read (rigup setup)`);
      continue;
    }
    const root = s.kind === 'marketplace' ? s.spec.path : s.marketplace.installLocation;
    const external = [];
    for (const name of s.wanted) {
      const plugin = (s.catalog.plugins || []).find(p => p.name === name);
      if (!plugin) continue;
      const dir = pluginFolder(root, s.catalog, plugin);
      // Installed plugins can be read from their installed copy, wherever they came from.
      const installed = s.installed.find(p => p.id.split('@')[0] === name);
      if (dir && ctx.stat(dir)) add(name, dir);
      else if (installed && installed.installPath && ctx.stat(installed.installPath)) add(name, installed.installPath);
      else external.push(name);
    }
    if (external.length) notes.push(`${s.label}: ${external.join(', ')} live outside the marketplace repo; their contents show once installed (rigup setup)`);
  }
  return { entries: sortEntries(entries), notes, facts };
}

/** Plugin ids installed and enabled here, or null when claude cannot say. */
function installedIds(facts) {
  if (!facts.claude.installed) return null;
  return new Set(facts.installed.filter(p => p.enabled !== false).map(p => p.id));
}

const forJson = (entries, installed) => entries.map(({ body: _b, ...e }) => ({ ...e, installed: installed ? installed.has(e.pluginId) : null }));

export function runList(ctx, args, { color = false, log = console.log, error = console.error } = {}) {
  try {
    const { entries, notes, facts } = loadCatalog(ctx);
    const installed = installedIds(facts);
    if (args.includes('--json')) log(JSON.stringify({ entries: forJson(entries, installed), notes }, null, 2));
    else log(formatList(entries, { installed, notes, color }));
    return 0;
  } catch (err) {
    error(`rigup list: ${err.message}`);
    return 1;
  }
}

export function runSearch(ctx, args, { color = false, log = console.log, error = console.error } = {}) {
  const query = args.filter(a => !a.startsWith('--')).join(' ').trim();
  if (!query) {
    error('rigup search: what are you looking for? e.g. rigup search pull request');
    return 2;
  }
  try {
    const { entries, facts } = loadCatalog(ctx);
    const results = searchCatalog(entries, query);
    const installed = installedIds(facts);
    if (args.includes('--json')) log(JSON.stringify(forJson(results, installed), null, 2));
    else log(formatSearch(results, query, { installed, color, limit: args.includes('--all') ? Infinity : 15 }));
    return 0;
  } catch (err) {
    error(`rigup search: ${err.message}`);
    return 1;
  }
}
