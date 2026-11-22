// Gathers what rigup needs to know about this machine and its sources. The only module (with
// the commands that apply changes) that runs commands or reads files, always through the injected
// context, so tests replace it with fixtures. Everything here is read-only.

import path from 'node:path';
import { CATALOG_PATH, GIT_ENV, LOCAL_MARKETPLACE, PLUGIN_MANIFEST_PATH, REQUIREMENTS_FILE } from './constants.mjs';
import { loadConfig } from './config.mjs';
import { parseClaudeVersion, parseCliJson, parseJson, parseLsRemote } from './parse.mjs';
import { classifyLocal, gitUrls, label, matchMarketplace, slugify } from './sources.mjs';

/**
 * @typedef {{ status: number|null, stdout: string, stderr: string, error?: Error }} RunResult
 * @typedef {{
 *   env: Record<string, string|undefined>, nodeVersion: string, home: string, cwd: string,
 *   configDir: string, configFile: string, dataDir: string, cacheDir: string,
 *   run: (cmd: string, args: string[], opts?: { timeout?: number, env?: Record<string,string> }) => RunResult,
 *   readFile: (file: string) => string|null,
 *   stat: (target: string) => ({ isDir: boolean, isFile: boolean, isSymlink: boolean, mtimeMs: number }|null),
 *   listDir: (dir: string) => string[]|null,
 *   newestMtime: (dir: string) => number|null,
 * }} Context
 */

/** Registered marketplaces and installed plugins, as Claude Code reports them. */
export function readClaudeState(ctx) {
  const marketplaces = parseCliJson(ctx.run('claude', ['plugin', 'marketplace', 'list', '--json'], { timeout: 30000 }).stdout);
  const plugins = parseCliJson(ctx.run('claude', ['plugin', 'list', '--json'], { timeout: 30000 }).stdout);
  return {
    marketplaces: Array.isArray(marketplaces) ? marketplaces : [],
    installed: Array.isArray(plugins) ? plugins.filter(p => typeof p.id === 'string') : [],
  };
}

/** @param {Context} ctx */
export function gatherFacts(ctx, { checkAccess = true } = {}) {
  const facts = { node: ctx.nodeVersion || null };

  const version = ctx.run('claude', ['--version'], { timeout: 15000 });
  facts.claude = {
    installed: version.status === 0,
    version: version.status === 0 ? parseClaudeVersion(version.stdout) : null,
  };
  const state = facts.claude.installed ? readClaudeState(ctx) : { marketplaces: [], installed: [] };
  facts.marketplaces = state.marketplaces;
  facts.installed = state.installed;

  facts.config = loadConfig(ctx);
  facts.userSettings = parseJson(ctx.readFile(path.join(ctx.configDir, 'settings.json')));

  const gh = ctx.run('gh', ['--version'], { timeout: 10000 });
  facts.gh = { installed: gh.status === 0, authenticated: false };
  if (facts.gh.installed) facts.gh.authenticated = ctx.run('gh', ['auth', 'status'], { timeout: 15000 }).status === 0;

  // The marketplace rigup generates for local plugin and flat folders.
  const local = facts.marketplaces.find(m => m.name === LOCAL_MARKETPLACE) || null;
  facts.localMarketplace = {
    dir: path.join(ctx.dataDir, 'marketplace'),
    registered: local,
    catalog: local ? parseJson(ctx.readFile(path.join(local.installLocation || local.path, CATALOG_PATH))) : null,
  };

  facts.sources = facts.config.sources.map(entry => sourceFacts(ctx, entry, facts, { checkAccess }));
  facts.requirements = facts.sources.flatMap(s => s.installed.map(p => {
    const plugin = p.id.split('@')[0];
    const dir = s.kind === 'plugin' ? s.spec.path : p.installPath;
    return { plugin, source: s.label, declared: dir ? parseJson(ctx.readFile(path.join(dir, REQUIREMENTS_FILE))) : null };
  })).filter(r => r.declared !== null);
  return facts;
}

/** Everything about one configured source. */
export function sourceFacts(ctx, entry, facts, { checkAccess = true } = {}) {
  const { spec, plugins: selection } = entry;
  const out = {
    id: spec.id, label: label(spec, ctx.home), spec, selection,
    kind: null, marketplace: null, catalog: null, cloneHead: null, access: null,
    pluginName: null, inLocalMarketplace: false, newestMtime: null,
  };

  if (spec.type === 'local') {
    const at = rel => path.join(spec.path, rel);
    const root = ctx.stat(spec.path);
    out.kind = classifyLocal({
      exists: Boolean(root && root.isDir),
      has: rel => ctx.stat(at(rel)) !== null,
      children: ctx.listDir(spec.path) || [],
      childHas: (name, rel) => ctx.stat(path.join(spec.path, name, rel)) !== null,
    });
    if (out.kind === 'marketplace') {
      out.marketplace = matchMarketplace(spec, facts.marketplaces);
      out.catalog = parseJson(ctx.readFile(at(CATALOG_PATH)));
    } else if (out.kind === 'plugin' || out.kind === 'flat') {
      const manifest = out.kind === 'plugin' ? parseJson(ctx.readFile(at(PLUGIN_MANIFEST_PATH))) : null;
      out.pluginName = (manifest && typeof manifest.name === 'string' && manifest.name) || slugify(path.basename(spec.path));
      out.marketplace = facts.localMarketplace.registered;
      const genPlugins = (facts.localMarketplace.catalog && facts.localMarketplace.catalog.plugins) || [];
      out.inLocalMarketplace = genPlugins.some(p => p.name === out.pluginName);
      out.newestMtime = ctx.newestMtime(spec.path);
    }
  } else {
    out.kind = 'remote';
    out.marketplace = matchMarketplace(spec, facts.marketplaces);
    const location = out.marketplace && out.marketplace.installLocation;
    if (location) {
      out.catalog = parseJson(ctx.readFile(path.join(location, CATALOG_PATH)));
      const head = ctx.run('git', ['-C', location, 'rev-parse', 'HEAD'], { timeout: 10000 });
      out.cloneHead = head.status === 0 ? head.stdout.trim() : null;
    }
    if (checkAccess) out.access = remoteAccess(ctx, spec);
  }

  out.marketplaceName = out.marketplace ? out.marketplace.name : (out.pluginName ? LOCAL_MARKETPLACE : null);
  out.available = out.pluginName
    ? [out.pluginName]
    : ((out.catalog && out.catalog.plugins) || []).map(p => p.name).filter(Boolean).sort();
  out.wanted = selection === '*' || out.pluginName ? out.available : [...selection].sort();
  out.installed = out.marketplaceName
    ? facts.installed.filter(p => p.id.endsWith(`@${out.marketplaceName}`) && (!out.pluginName || p.id.split('@')[0] === out.pluginName))
    : [];
  return out;
}

/** Can git reach a remote source without a prompt, and what is its head? */
export function remoteAccess(ctx, spec) {
  const ref = spec.ref ? `refs/heads/${spec.ref}` : 'HEAD';
  for (const url of gitUrls(spec)) {
    const res = ctx.run('git', ['ls-remote', url, ref], { timeout: 20000, env: GIT_ENV });
    const head = res.status === 0 ? parseLsRemote(res.stdout) : null;
    if (head) return { ok: true, url, head };
  }
  return { ok: false, url: null, head: null };
}

/**
 * Resolves whether each declared tool, env var and connector is present. Kept separate because
 * connector lookups cost a few seconds each (`claude mcp get` checks the server).
 * @param {Context} ctx
 */
export function resolveRequirements(ctx, requirements) {
  const toolCache = new Map();
  const connectorCache = new Map();
  const hasTool = name => {
    if (!toolCache.has(name)) {
      toolCache.set(name, ctx.run('sh', ['-c', `command -v ${shellQuote(name)}`], { timeout: 5000 }).status === 0);
    }
    return toolCache.get(name);
  };
  const connector = name => {
    if (!connectorCache.has(name)) {
      const res = ctx.run('claude', ['mcp', 'get', name], { timeout: 30000 });
      connectorCache.set(name, res.status === 0 ? res.stdout : null);
    }
    return connectorCache.get(name);
  };

  return requirements.map(({ plugin, declared }) => ({
    plugin,
    tools: (declared.tools || []).map(t => ({ ...t, present: hasTool(t.name) })),
    env: (declared.env || []).map(e => ({ ...e, present: Boolean(ctx.env[e.name]) })),
    connectors: (declared.connectors || []).map(c => {
      const names = [c.name, ...(c.alternatives || [])];
      const found = names.find(n => connector(n) !== null) || null;
      return { ...c, found, output: found ? connector(found) : null };
    }),
  }));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
