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

/** The body after the frontmatter. */
export function body(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}
