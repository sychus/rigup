// Pure parsers for the outputs rigup reads. No I/O here, so every function is unit-tested
// against fixtures captured from a real machine.

/** "2.1.328 (Claude Code)" -> "2.1.328"; null when no version is found. */
export function parseClaudeVersion(text) {
  const match = /(\d+\.\d+\.\d+)/.exec(text || '');
  return match ? match[1] : null;
}

/** Semver-ish compare of "x.y.z" strings: negative, zero or positive. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** JSON.parse that returns null instead of throwing (bad or missing input). */
export function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `claude plugin ... --json` prints its result as the last stdout line; some commands print
 * a single JSON document. Accept both.
 */
export function parseCliJson(stdout) {
  const whole = parseJson(stdout);
  if (whole !== null) return whole;
  const lines = (stdout || '').trim().split('\n');
  return parseJson(lines[lines.length - 1]);
}

/** First SHA from `git ls-remote <url> <ref>` output, or null. */
export function parseLsRemote(stdout) {
  const match = /^([0-9a-f]{40})\s/m.exec(stdout || '');
  return match ? match[1] : null;
}

/** "Status: ✔ Connected" from `claude mcp get <name>` -> "connected" | "needs-auth" | "failed" | "unknown". */
export function parseMcpGetStatus(stdout) {
  const line = /Status:\s*(.+)/.exec(stdout || '');
  if (!line) return 'unknown';
  const status = line[1].toLowerCase();
  if (status.includes('connected')) return 'connected';
  if (status.includes('auth')) return 'needs-auth';
  if (status.includes('fail')) return 'failed';
  return 'unknown';
}

/** Short SHA for display. */
export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '?';
}
