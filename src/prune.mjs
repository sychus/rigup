// rigup prune: the plugins of your sources you did not use lately, so they stop costing tokens on
// every prompt. Pure functions only; reading transcripts and changing things is in
// prune-command.mjs.
//
// Use is read from Claude Code's own transcripts, on this machine only. Three signals, each in
// the exact envelope Claude Code writes, with the plugin name as the prefix of what was used:
//   a skill the model ran           "name":"Skill","input":{"skill":"<plugin>:<name>"
//   an agent the model started      "subagent_type":"<plugin>:<name>"
//   a slash command you typed       "content":"<command-message>…</command-message>\n<command-name>/<plugin>:<name>
// The same text quoted in a tool result or a file does not count: there its quotes are escaped
// (\"skill\":…), and a <command-name> tag is not the start of a message's content.
// The transcript names the plugin, not its marketplace: two sources with a plugin of the same
// name share its uses, which can only make prune suggest less, never more.

import { formatTokens } from './frontmatter.mjs';

export const DEFAULT_DAYS = 28;
const DAY = 24 * 60 * 60 * 1000;

const SIGNALS = [
  /"name":"Skill","input":\{"skill":"([A-Za-z0-9._-]+):/g,
  /"subagent_type":"([A-Za-z0-9._-]+):/g,
  /"content":"<command-message>[^"<]*<\/command-message>\\n<command-name>\/([A-Za-z0-9._-]+):/g,
];

/** Uses per plugin name in one transcript, for the names in `names` only: Map(name -> count). */
export function scanUsage(text, names) {
  const uses = new Map();
  if (!text) return uses;
  for (const re of SIGNALS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (names.has(m[1])) uses.set(m[1], (uses.get(m[1]) || 0) + 1);
    }
  }
  return uses;
}

/** Days given with --days, or the default. Returns null for anything that is not a whole number >= 1. */
export function parseDays(args) {
  const i = args.indexOf('--days');
  if (i === -1) return DEFAULT_DAYS;
  const n = Number(args[i + 1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The report: one row per plugin of your sources that is installed and enabled here.
 *   plugins   [{ id, name, source (label), sourceId, kind (source kind), scope, installedAt }]
 *   usage     Map(name -> { uses, lastSeen })
 *   tokens    { pluginId: prompt tokens }
 *   oldest    mtime of the oldest transcript (ms), or null
 * A plugin is unused when it had no use in the whole window, the transcripts go back that far,
 * and it was not installed inside the window.
 */
export function pruneReport({ plugins, usage, tokens = {}, oldest, now, days }) {
  const cutoff = now - days * DAY;
  const enoughHistory = oldest !== null && oldest !== undefined && oldest <= cutoff;
  const rows = plugins.map(p => {
    const u = usage.get(p.name) || { uses: 0, lastSeen: null };
    const since = p.installedAt ? Date.parse(p.installedAt) : null;
    const recent = since !== null && since > cutoff;
    return {
      ...p,
      uses: u.uses,
      lastSeen: u.lastSeen ? new Date(u.lastSeen).toISOString() : null,
      tokens: tokens[p.id] || 0,
      recent,
      unused: enoughHistory && u.uses === 0 && !recent,
    };
  });
  return { days, enoughHistory, rows, unused: rows.filter(r => r.unused) };
}

/**
 * What --yes does for the unused plugins. A plugin from a marketplace source is uninstalled and
 * left out of the config (so rigup setup does not bring it back). A local plugin or skills folder
 * is its own source: rigup only prints how to remove it.
 */
export function planPrune(unused) {
  const actions = [];
  for (const r of unused) {
    if (r.kind === 'plugin' || r.kind === 'flat') {
      actions.push({ kind: 'hint', title: `${r.name} is the local folder ${r.source}`, fix: `rigup remove ${r.source} && claude plugin uninstall ${r.id} --scope user` });
    } else if (r.scope && r.scope !== 'user') {
      // Not rigup's install (a managed policy, a project): only the one who installed it can remove it.
      actions.push({ kind: 'hint', title: `${r.name} was installed at ${r.scope} scope, not by rigup`, fix: r.scope === 'managed' ? `claude plugin disable ${r.id}` : `claude plugin uninstall ${r.id} --scope ${r.scope}, in that project` });
    } else {
      actions.push({ kind: 'prune', title: `removed ${r.name} (left out of ${r.source})`, id: r.id, name: r.name, sourceId: r.sourceId });
    }
  }
  return actions;
}

/** rigup prune output (without --yes). */
export function formatPrune(report, { color = false } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const lines = [`rigup prune · plugins of your sources, by use in the last ${report.days} days`, ''];
  if (!report.rows.length) {
    lines.push(paint(2, '  No plugin of your sources is installed here (rigup setup).'));
    return lines.join('\n');
  }
  const width = Math.max(10, ...report.rows.map(r => r.name.length));
  const use = r => (r.uses ? `${r.uses} use${r.uses === 1 ? '' : 's'}, last ${r.lastSeen.slice(0, 10)}` : 'no use');
  let source = null;
  for (const r of report.rows) {
    if (r.source !== source) {
      source = r.source;
      lines.push(paint(4, source));
    }
    const note = r.unused ? paint(33, '  · unused') : r.recent ? paint(2, '  · installed recently, too soon to tell') : '';
    lines.push(`  ${paint(1, r.name.padEnd(width))}  ${use(r)} ${paint(2, `· ${formatTokens(r.tokens)} tokens per prompt`)}${note}`);
  }

  lines.push('');
  if (!report.enoughHistory) {
    lines.push(`Not enough history yet: this machine's Claude transcripts do not go back ${report.days} days. Nothing to suggest.`);
  } else if (!report.unused.length) {
    const tooNew = report.rows.some(r => r.recent && !r.uses);
    lines.push(paint(32, `✔ Nothing to prune: every plugin was used${tooNew ? ' or is too new to tell' : ''}.`));
  } else {
    const saved = report.unused.reduce((sum, r) => sum + r.tokens, 0);
    lines.push(`Unused for ${report.days} days: removing ${report.unused.length === 1 ? 'it' : 'them'} saves ${formatTokens(saved)} tokens on every prompt.`);
    lines.push(paint(2, 'rigup prune --yes uninstalls them and leaves them out of your config, so rigup setup does not bring them back.'));
  }
  return lines.join('\n');
}
