// rigup's config: the list of sources and which plugins to take from each.
//
// ~/.config/rigup/config.json (XDG_CONFIG_HOME respected, RIGUP_CONFIG overrides):
// {
//   "sources": [
//     { "source": "acme/claude-skills", "plugins": "*" },
//     { "source": "~/work/my-skills" },
//     { "source": "acme/big-marketplace", "plugins": ["code-review", "release"] }
//   ]
// }
// `plugins` defaults to "*" (every plugin in the source's catalog). `exclude` lists plugins to
// leave out of "*" (rigup prune --yes adds to it), so new catalog plugins still arrive.
//     { "source": "acme/claude-skills", "exclude": ["legacy"] }

import { parseJson } from './parse.mjs';
import { parseSpec } from './sources.mjs';

export const EMPTY_CONFIG = Object.freeze({ sources: [] });

/**
 * Validates a parsed config. Returns { sources: [{ source, plugins, spec }], errors: [] }, where
 * `spec` is the parsed source (see sources.mjs).
 */
export function normalizeConfig(raw, { home, cwd } = {}) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { sources: [], errors: ['config must be a JSON object with a "sources" list'] };
  }
  const list = raw.sources === undefined ? [] : raw.sources;
  if (!Array.isArray(list)) return { sources: [], errors: ['"sources" must be a list'] };
  const sources = [];
  const seen = new Set();
  list.forEach((entry, i) => {
    const item = typeof entry === 'string' ? { source: entry } : entry;
    if (!item || typeof item.source !== 'string') {
      errors.push(`sources[${i}]: needs a "source" string`);
      return;
    }
    const spec = parseSpec(item.source, { home, cwd });
    if (spec.error) {
      errors.push(`sources[${i}]: ${spec.error}`);
      return;
    }
    const plugins = item.plugins === undefined ? '*' : item.plugins;
    if (plugins !== '*' && !(Array.isArray(plugins) && plugins.every(p => typeof p === 'string'))) {
      errors.push(`sources[${i}]: "plugins" must be "*" or a list of plugin names`);
      return;
    }
    const exclude = item.exclude === undefined ? [] : item.exclude;
    if (!(Array.isArray(exclude) && exclude.every(p => typeof p === 'string'))) {
      errors.push(`sources[${i}]: "exclude" must be a list of plugin names`);
      return;
    }
    if (seen.has(spec.id)) {
      errors.push(`sources[${i}]: ${spec.id} is listed twice`);
      return;
    }
    seen.add(spec.id);
    sources.push({ source: item.source, plugins, exclude, spec });
  });
  return { sources, errors };
}

/** Reads the config file. A missing file is an empty config; an unreadable one is an error. */
export function loadConfig(ctx) {
  const text = ctx.readFile(ctx.configFile);
  if (text === null) return { raw: { ...EMPTY_CONFIG, sources: [] }, sources: [], errors: [], exists: false };
  const raw = parseJson(text);
  if (raw === null) return { raw: null, sources: [], errors: [`${ctx.configFile} is not valid JSON`], exists: true };
  return { raw, ...normalizeConfig(raw, ctx), exists: true };
}

export function saveConfig(ctx, raw) {
  ctx.writeFile(ctx.configFile, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Adds a source to a raw config (returns a new object). Throws with a readable message. */
export function addSource(raw, input, { plugins = null, home, cwd } = {}) {
  const spec = parseSpec(input, { home, cwd });
  if (spec.error) throw new Error(spec.error);
  const current = normalizeConfig(raw, { home, cwd });
  if (current.sources.some(s => s.spec.id === spec.id)) throw new Error(`${spec.id} is already a source`);
  // Store local paths absolute, so the config works from any folder.
  const entry = { source: spec.type === 'local' ? spec.path : spec.id };
  if (plugins) entry.plugins = plugins;
  return { ...raw, sources: [...(raw.sources || []), entry] };
}

/**
 * Stops taking `names` from a source: dropped from an explicit `plugins` list, or added to
 * `exclude` when the source takes "*". Returns a new raw config.
 */
export function excludePlugins(raw, sourceId, names, { home, cwd } = {}) {
  const sources = (raw.sources || []).map(entry => {
    const item = typeof entry === 'string' ? { source: entry } : { ...entry };
    if (parseSpec(item.source, { home, cwd }).id !== sourceId) return entry;
    const plugins = item.plugins === undefined ? '*' : item.plugins;
    if (plugins === '*') item.exclude = [...new Set([...(item.exclude || []), ...names])].sort();
    else item.plugins = plugins.filter(p => !names.includes(p));
    return item;
  });
  return { ...raw, sources };
}

/** Removes a source by what the user typed (same parsing as add). Throws when it is not there. */
export function removeSource(raw, input, { home, cwd } = {}) {
  const spec = parseSpec(input, { home, cwd });
  if (spec.error) throw new Error(spec.error);
  const list = raw.sources || [];
  const keep = list.filter(entry => {
    const parsed = parseSpec(typeof entry === 'string' ? entry : entry.source, { home, cwd });
    return parsed.id !== spec.id;
  });
  if (keep.length === list.length) throw new Error(`${spec.id} is not a source (see rigup sources)`);
  return { ...raw, sources: keep };
}
