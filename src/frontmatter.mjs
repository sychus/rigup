// SKILL.md / agent / command frontmatter helpers. Pure.

/** First line of the `description:` frontmatter field (handles quotes and `>` / `|` blocks). */
export function frontmatterDescription(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex(l => /^description:/.test(l));
  if (i === -1) return null;
  let value = lines[i].replace(/^description:\s*/, '');
  if (/^[>|][-+]?\s*$/.test(value)) {
    // The block ends at the first line that is not indented (the next key).
    const block = [];
    for (const l of lines.slice(i + 1)) {
      if (!/^\s+\S/.test(l)) break;
      block.push(l.trim());
    }
    value = block.join(' ');
  }
  value = value.trim().replace(/^["']|["']$/g, '').trim();
  return value || null;
}

/** One-line description, cut at the first sentence or ~110 chars. */
export function shortDescription(text, max = 110) {
  if (!text) return '';
  const sentence = text.split(/(?<=\.)\s/)[0];
  const one = sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
  return one.replace(/\.$/, '');
}

/**
 * Rough tokens a component adds to every prompt while its plugin is on: Claude Code lists each
 * skill, command and agent by name and description so the model can pick one. A component with
 * `disable-model-invocation: true` is left out of that list. Estimate: characters / 4.
 */
export function contextTokens(plugin, name, text, description) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (fm && /^disable-model-invocation:\s*true\s*$/m.test(fm[1])) return 0;
  return Math.ceil(`${plugin}:${name}: ${description || ''}`.length / 4);
}

/** "~840", "~1.2k", "~12k": a token estimate, never shown as exact. */
export function formatTokens(n) {
  if (!n) return '0';
  const tens = Math.max(10, Math.round(n / 10) * 10);
  if (tens < 1000) return `~${tens}`;
  return n < 10000 ? `~${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `~${Math.round(n / 1000)}k`;
}

/** The body after the frontmatter. */
export function body(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}
