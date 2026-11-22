// rigup doctor: read-only diagnosis of this machine's Claude Code setup against the config.

import { gatherFacts, resolveRequirements } from './facts.mjs';
import { runChecks } from './checks.mjs';

const SYMBOL = { ok: '✔', warn: '⚠', fail: '✖', info: 'ℹ' };
const COLOR = { ok: 32, warn: 33, fail: 31, info: 36 };

/**
 * Which rigup command would help next, from the `by` tag of each problem:
 *   'setup'   setup fixes at least one problem
 *   'update'  only `rigup update` fixes something (stale clone, edited local folder)
 *   'none'    nothing rigup can do; fix the ✖ / ⚠ items by hand
 */
export function nextStep(sections) {
  const problems = sections.flatMap(s => s.results).filter(r => r.status === 'fail' || r.status === 'warn');
  if (problems.some(r => r.by === 'setup')) return 'setup';
  if (problems.some(r => r.by === 'update')) return 'update';
  return 'none';
}

/** Runs every check and returns { sections, counts, next }. */
export function doctor(ctx) {
  const facts = gatherFacts(ctx);
  const resolved = resolveRequirements(ctx, facts.requirements);
  const sections = runChecks(facts, ctx.env, resolved, { configFile: ctx.configFile }).filter(s => s.results.length);
  const counts = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const s of sections) for (const r of s.results) counts[r.status]++;
  return { sections, counts, next: nextStep(sections) };
}

/** The closing hint after the counts. */
export function summaryHint({ counts, next }) {
  if (!counts.fail && !counts.warn) return 'all good';
  if (next === 'setup') return 'run `rigup setup` to fix what it can';
  if (next === 'update') return 'run `rigup update`';
  return counts.fail ? 'fix the ✖ items above' : 'nothing for rigup to fix: see the ⚠ items above';
}

/** Human-readable report. `color` adds ANSI colors (only when stdout is a TTY). */
export function formatReport({ sections, counts, next }, { color = false } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const lines = ['rigup doctor', ''];
  for (const section of sections) {
    lines.push(paint(1, section.title));
    for (const r of section.results) {
      lines.push(`  ${paint(COLOR[r.status], SYMBOL[r.status])} ${r.title}`);
      if (r.fix) lines.push(paint(2, `      fix: ${r.fix}`));
    }
  }
  lines.push('');
  const summary = `${counts.fail} error${counts.fail === 1 ? '' : 's'} · ${counts.warn} warning${counts.warn === 1 ? '' : 's'}`;
  lines.push(`${summary}  →  ${summaryHint({ counts, next })}`);
  return lines.join('\n');
}

/** Exit code: 1 when something required is missing, 0 otherwise (warnings do not fail). */
export function exitCode({ counts }) {
  return counts.fail > 0 ? 1 : 0;
}
