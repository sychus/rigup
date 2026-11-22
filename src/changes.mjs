// rigup changes: what is new, updated, renamed or removed between two commits of a source.
// Pure functions only (path mapping, classification, formatting); git lives in history.mjs.

const KIND_ORDER = { skill: 0, agent: 1, command: 2 };
const STATUS_ORDER = { new: 0, renamed: 1, updated: 2, removed: 3 };

/**
 * Maps a repo path to the component it belongs to, or null. `roots` says where each plugin lives
 * in the repo: [{ prefix: 'plugins/review', plugin: 'review', flat?: true }] (prefix '' = repo root).
 * The longest matching prefix wins, so nested plugins map to the innermost one.
 */
export function componentOf(file, roots) {
  let best = null;
  for (const r of roots) {
    const p = r.prefix ? `${r.prefix}/` : '';
    if (file.startsWith(p) && (!best || p.length > best.p.length)) best = { ...r, p };
  }
  if (!best) return null;
  const rest = file.slice(best.p.length);
  if (best.flat) {
    const m = /^([^/.][^/]*)\/(.+)$/.exec(rest);
    return m ? { plugin: best.plugin, kind: 'skill', name: m[1], main: m[2] === 'SKILL.md', rel: `${best.p}${m[1]}/SKILL.md` } : null;
  }
  let m = /^skills\/([^/]+)\/(.+)$/.exec(rest);
  if (m) return { plugin: best.plugin, kind: 'skill', name: m[1], main: m[2] === 'SKILL.md', rel: `${best.p}skills/${m[1]}/SKILL.md` };
  m = /^(agents|commands)\/([^/]+)\.md$/.exec(rest);
  if (m) return { plugin: best.plugin, kind: m[1].slice(0, -1), name: m[2], main: true, rel: file };
  return null;
}

/** Parses `git diff --name-status -M` output into { status, from?, file } entries. */
export function parseNameStatus(text) {
  return (text || '').split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const code = parts[0][0];
    if (code === 'R' || code === 'C') return { status: code, from: parts[1], file: parts[2] };
    return { status: code, file: parts[1] };
  });
}

/**
 * Turns name-status entries into one item per component: new (its main file was added), removed
 * (main file deleted), renamed (main file moved to a new name), updated (anything else inside it
 * changed). Items carry `rel`, the main file's repo path, to read its description.
 */
export function classifyChanges(entries, roots) {
  const items = new Map();
  const key = c => `${c.plugin}|${c.kind}|${c.name}`;
  const upsert = (c, status, extra = {}) => {
    const k = key(c);
    const prev = items.get(k);
    // A component's main-file status (new/removed/renamed) wins over "updated".
    if (!prev || (prev.status === 'updated' && status !== 'updated')) {
      items.set(k, { plugin: c.plugin, kind: c.kind, name: c.name, rel: c.rel, status, ...extra });
    }
  };
  for (const e of entries) {
    if (e.status === 'R') {
      const from = componentOf(e.from, roots);
      const to = componentOf(e.file, roots);
      if (from && to && from.main && to.main && key(from) !== key(to)) {
        upsert(to, 'renamed', { from: from.plugin === to.plugin ? from.name : `${from.plugin}/${from.name}`, fromRel: from.rel });
        items.delete(key(from));
        continue;
      }
      if (to) upsert(to, 'updated');
      continue;
    }
    const c = componentOf(e.file, roots);
    if (!c) continue;
    if (c.main && e.status === 'A') upsert(c, 'new');
    else if (c.main && e.status === 'D') upsert(c, 'removed');
    else upsert(c, 'updated');
  }
  return [...items.values()].sort((a, b) => a.plugin.localeCompare(b.plugin)
    || STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.name.localeCompare(b.name));
}

export function countChanges(items) {
  const counts = { total: items.length, new: 0, updated: 0, renamed: 0, removed: 0 };
  for (const it of items) counts[it.status]++;
  return counts;
}

function label(it) {
  const kind = it.kind === 'skill' ? '' : ` (${it.kind})`;
  return it.status === 'renamed' ? `${it.from} → ${it.name}${kind}` : `${it.name}${kind}`;
}

/**
 * Human-readable report for several sources:
 * results = [{ source, base, head, items } | { source, skipped: reason }]
 */
export function formatChanges(results, { window, title, color = false } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const STATUS_COLOR = { new: 32, updated: 33, renamed: 36, removed: 31 };
  const all = results.flatMap(r => r.items || []);
  const counts = countChanges(all);
  const lines = [title || `rigup changes · ${window}`];
  const parts = ['new', 'updated', 'renamed', 'removed'].filter(s => counts[s]).map(s => `${counts[s]} ${s}`);
  lines.push(all.length ? `${counts.total} item${counts.total === 1 ? '' : 's'} · ${parts.join(' · ')}` : 'No skill, agent or command changed in this window.');
  const width = Math.min(34, Math.max(10, ...all.map(it => label(it).length)));
  for (const r of results) {
    if (r.skipped) {
      lines.push('', `${paint(4, r.source)}  ${paint(2, `(${r.skipped})`)}`);
      continue;
    }
    if (!r.items.length) continue;
    lines.push('', `${paint(4, r.source)}  ${paint(2, `${r.base.slice(0, 7)} → ${r.head.slice(0, 7)}`)}`);
    let plugin = null;
    for (const it of r.items) {
      if (it.plugin !== plugin) {
        plugin = it.plugin;
        lines.push(`  ${paint(1, plugin)}`);
      }
      const desc = it.description ? paint(2, `— ${it.description}`) : '';
      lines.push(`    ${paint(STATUS_COLOR[it.status], it.status.padEnd(8))} ${label(it).padEnd(width)} ${desc}`.trimEnd());
    }
  }
  return lines.join('\n');
}
