// `rigup changes [--since 7d|2w|YYYY-MM-DD|<commit>] [--until YYYY-MM-DD] [--json]`:
// what changed in each source's wanted plugins, from git history.

import { gatherFacts } from './facts.mjs';
import { countChanges, formatChanges } from './changes.mjs';
import { computeChanges, openHistory, resolveBound, rootCommit } from './history.mjs';
import { flagValue } from './sources-command.mjs';

/** Changes for every source in a window. Never throws: a source that fails says why. */
export function changesForSources(ctx, facts, { since = '7d', until = null } = {}) {
  return facts.sources.map(s => {
    try {
      const hist = openHistory(ctx, s);
      const head = until ? resolveBound(ctx, hist.dir, hist.head, until, { endOfDay: true }) : hist.head;
      if (!head) return { source: s.label, skipped: `nothing before ${until}` };
      // A window that starts before the first commit covers the whole history.
      const base = resolveBound(ctx, hist.dir, head, since) || rootCommit(ctx, hist.dir, head);
      if (!base) return { source: s.label, skipped: `cannot resolve --since ${since}` };
      return { source: s.label, base, head, items: computeChanges(ctx, s, hist, base, head) };
    } catch (err) {
      return { source: s.label, skipped: err.message };
    }
  });
}

export function runChanges(ctx, args, { color = false, log = console.log, error = console.error } = {}) {
  const since = flagValue(args, '--since') || '7d';
  const until = flagValue(args, '--until');
  const facts = gatherFacts(ctx, { checkAccess: false });
  if (facts.config.errors.length || !facts.sources.length) {
    error(`rigup changes: ${facts.config.errors[0] || 'no sources yet (rigup add <source>)'}`);
    return 1;
  }
  const results = changesForSources(ctx, facts, { since, until });
  const window = until ? `${since} to ${until}` : `since ${/^\d+[dw]$/.test(since) ? `${since} ago` : since}`;
  if (args.includes('--json')) {
    const items = results.flatMap(r => r.items || []);
    log(JSON.stringify({ since, until, counts: countChanges(items), sources: results }, null, 2));
  } else {
    log(formatChanges(results, { window, color }));
  }
  return results.every(r => r.skipped) ? 1 : 0;
}
