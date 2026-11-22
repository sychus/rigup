// rigup list / rigup search: every skill, agent and command across your sources.
// Pure functions only (ranking and formatting); reading the folders is in catalog-command.mjs.

const KIND_ORDER = { skill: 0, agent: 1, command: 2 };

export function sortEntries(entries) {
  return entries.sort((a, b) => a.source.localeCompare(b.source)
    || a.plugin.localeCompare(b.plugin)
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.name.localeCompare(b.name));
}

/** How to use an entry in Claude Code. */
export function usage(entry) {
  if (entry.kind === 'agent') return `agent ${entry.plugin}:${entry.name}`;
  return `/${entry.plugin}:${entry.name}`;
}

/**
 * Search: every word of the query must appear in the name, plugin, description or body.
 * Ranked by where it matched (name > description > body); ties go to the entry that mentions
 * the topic more, then by plugin and name.
 */
export function searchCatalog(entries, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = [];
  for (const e of entries) {
    const name = `${e.plugin} ${e.name}`.toLowerCase();
    const desc = (e.description || '').toLowerCase();
    const text = (e.body || '').toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      if (name.includes(w)) score += 3;
      else if (desc.includes(w)) score += 2;
      else if (text.includes(w)) score += 1;
      else { all = false; break; }
      score += Math.min(occurrences(desc, w) + occurrences(text, w), 10) * 0.1;
    }
    if (all) results.push({ ...e, score });
  }
  return results.sort((a, b) => b.score - a.score || a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name));
}

function occurrences(text, word) {
  let n = 0;
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + word.length)) n++;
  return n;
}

const paintWith = color => (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const kindTag = e => (e.kind === 'skill' ? '' : ` (${e.kind})`);

/**
 * rigup list: grouped by source, then plugin. `notes` are lines about plugins or sources whose
 * contents could not be read (external plugin sources, unregistered repos).
 */
export function formatList(entries, { installed = null, notes = [], color = false } = {}) {
  const paint = paintWith(color);
  const c = { plugins: new Set(entries.map(e => `${e.source}|${e.plugin}`)).size, skill: 0, agent: 0, command: 0 };
  for (const e of entries) c[e.kind]++;
  const lines = [`rigup list · ${c.plugins} plugin${c.plugins === 1 ? '' : 's'} · ${c.skill} skills · ${c.agent} agents · ${c.command} commands`];
  if (!entries.length && !notes.length) {
    lines.push('', 'Nothing yet. Add a source with rigup add, then rigup setup.');
    return lines.join('\n');
  }
  const width = Math.min(36, Math.max(10, ...entries.map(e => e.name.length + kindTag(e).length)));
  let source = null;
  let plugin = null;
  for (const e of entries) {
    if (e.source !== source) {
      source = e.source;
      plugin = null;
      lines.push('', paint(4, source));
    }
    if (e.plugin !== plugin) {
      plugin = e.plugin;
      const tag = installed && !installed.has(e.pluginId) ? paint(33, '  (not installed: rigup setup)') : '';
      lines.push(`  ${paint(1, plugin)}${tag}`);
    }
    lines.push(`    ${`${e.name}${kindTag(e)}`.padEnd(width)} ${paint(2, e.short ? `— ${e.short}` : '')}`.trimEnd());
  }
  if (notes.length) lines.push('', ...notes.map(n => paint(2, `ℹ ${n}`)));
  lines.push('', paint(2, 'Use a skill or command as /<plugin>:<name>. Search with rigup search <words>.'));
  return lines.join('\n');
}

/** rigup search: ranked matches, each with how to use it. */
export function formatSearch(results, query, { installed = null, color = false, limit = 15 } = {}) {
  const paint = paintWith(color);
  if (!results.length) return `rigup search · nothing matches "${query}"\n\nTry fewer or different words, or rigup list for everything.`;
  const shown = results.slice(0, limit);
  const lines = [`rigup search · ${results.length} match${results.length === 1 ? '' : 'es'} for "${query}"${results.length > limit ? ` (top ${limit}; --all for every match)` : ''}`, ''];
  for (const e of shown) {
    const missing = installed && !installed.has(e.pluginId) ? paint(33, '  · not installed: rigup setup') : '';
    lines.push(`  ${paint(1, `${e.plugin} · ${e.name}${kindTag(e)}`)}${missing}`);
    if (e.short) lines.push(`    ${paint(2, e.short)}`);
    lines.push(`    use: ${usage(e)}`);
  }
  return lines.join('\n');
}
