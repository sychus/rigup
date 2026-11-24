// `rigup prune`: reads this machine's Claude transcripts (locally, plugin names only) and lists
// the plugins of your sources you did not use. --yes uninstalls them and leaves them out of the
// config.

import path from 'node:path';
import { loadCatalog } from './catalog-command.mjs';
import { excludePlugins, loadConfig, saveConfig } from './config.mjs';
import { gatherFacts } from './facts.mjs';
import { formatPrune, parseDays, planPrune, pruneReport, scanUsage } from './prune.mjs';

const DAY = 24 * 60 * 60 * 1000;

/** Uses per plugin name in the transcripts changed inside the window, plus the oldest transcript's time. */
export function readUsage(ctx, days, names) {
  const files = ctx.listFiles(path.join(ctx.configDir, 'projects'), '.jsonl');
  const cutoff = ctx.now().getTime() - days * DAY;
  const usage = new Map();
  for (const f of files.filter(x => x.mtimeMs >= cutoff)) {
    for (const [name, n] of scanUsage(ctx.readFile(f.path), names)) {
      const u = usage.get(name) || { uses: 0, lastSeen: 0 };
      usage.set(name, { uses: u.uses + n, lastSeen: Math.max(u.lastSeen, f.mtimeMs) });
    }
  }
  const oldest = files.length ? Math.min(...files.map(f => f.mtimeMs)) : null;
  return { usage, oldest };
}

export function runPrune(ctx, args, { color = false, log = console.log, error = console.error } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const days = parseDays(args);
  if (days === null) {
    error('rigup prune: --days needs a whole number of days, e.g. rigup prune --days 60');
    return 2;
  }
  const facts = gatherFacts(ctx, { checkAccess: false });
  if (!facts.claude.installed) {
    error('rigup prune: Claude Code is not installed.');
    return 1;
  }
  if (facts.config.errors.length) {
    for (const e of facts.config.errors) error(`rigup: ${e}`);
    return 1;
  }
  // The installed, enabled plugins of your sources. Plugins from elsewhere are not rigup's.
  const plugins = facts.sources.flatMap(s => s.installed
    .filter(p => p.enabled !== false)
    .map(p => ({ id: p.id, name: p.id.split('@')[0], source: s.label, sourceId: s.id, kind: s.kind, scope: p.scope, installedAt: p.installedAt || null })));
  let tokens = {};
  try {
    for (const e of loadCatalog(ctx, facts).entries) tokens[e.pluginId] = (tokens[e.pluginId] || 0) + (e.tokens || 0);
  } catch { tokens = {}; }

  const { usage, oldest } = readUsage(ctx, days, new Set(plugins.map(p => p.name)));
  const report = pruneReport({ plugins, usage, tokens, oldest, now: ctx.now().getTime(), days });
  if (args.includes('--json')) {
    log(JSON.stringify({ ...report, unused: report.unused.map(r => r.id) }, null, 2));
    return 0;
  }
  log(formatPrune(report, { color }));
  if (!args.includes('--yes') || !report.unused.length) return 0;

  log('');
  let raw = loadConfig(ctx).raw;
  let failed = false;
  let changed = false;
  for (const action of planPrune(report.unused)) {
    if (action.kind === 'hint') {
      log(`  ${paint(33, '⚠')} ${action.title}`);
      log(paint(2, `      ${action.fix}`));
      continue;
    }
    const res = ctx.run('claude', ['plugin', 'uninstall', action.id, '--scope', 'user', '--json'], { timeout: 180000 });
    if (res.status !== 0) {
      log(`  ${paint(31, '✖')} could not remove ${action.name}`);
      log(paint(2, `      ${(res.stderr || res.stdout || '').trim().split('\n').pop() || `exit ${res.status}`}`));
      failed = true;
      continue;
    }
    raw = excludePlugins(raw, action.sourceId, [action.name], ctx);
    saveConfig(ctx, raw);
    log(`  ${paint(32, '✔')} ${action.title}`);
    changed = true;
  }
  if (changed) log('\nRestart open Claude sessions to load the change. To bring one back, drop it from "exclude" in the config and run rigup setup.');
  return failed ? 1 : 0;
}
