// `rigup setup` command: gather facts, plan, apply, then re-check with doctor.

import { gatherFacts } from './facts.mjs';
import { applySetup, planSetup } from './setup.mjs';
import { doctor, exitCode } from './doctor.mjs';

const SYMBOL = { done: '✔', planned: '→', hint: '⚠', stop: '✖', failed: '✖' };
const COLOR = { done: 32, planned: 36, hint: 33, stop: 31, failed: 31 };

/** Runs setup and prints its report. Returns the process exit code. */
export function runSetup(ctx, { dryRun = false, color = false, log = console.log } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  log(`rigup setup${dryRun ? ' --dry-run' : ''}\n`);

  const facts = gatherFacts(ctx);
  const plan = planSetup(facts, ctx.env);
  const printStep = step => {
    log(`  ${paint(COLOR[step.status], SYMBOL[step.status])} ${step.title}`);
    if (step.detail) log(paint(2, `      ${step.status === 'planned' ? '' : 'fix: '}${step.detail}`));
  };

  // Hints are advice, not work: a plan of only hints still means "nothing to do".
  if (plan.every(a => a.kind === 'hint')) {
    plan.forEach(a => printStep({ title: a.title, status: 'hint', detail: a.fix }));
    log(`${plan.length ? '\n' : ''}${paint(32, '✔')} Nothing to do. Everything in the config is set up.`);
    return 0;
  }

  const { steps, changed } = applySetup(ctx, plan, { dryRun, facts, onStep: printStep });
  const blocked = steps.some(s => s.status === 'stop' || s.status === 'failed');
  if (dryRun) {
    log(`\n${blocked ? 'Setup would stop at the step above.' : 'Dry run: nothing was changed. Run `rigup setup` to apply.'}`);
    return blocked ? 1 : 0;
  }
  if (blocked) {
    log('\nSetup stopped. Fix the step above and run `rigup setup` again; it picks up where it left off.');
    return 1;
  }

  // Re-check with doctor so the summary reflects the machine after setup, not the plan.
  const report = doctor(ctx);
  const leftovers = report.sections.flatMap(s => s.results).filter(r => r.status === 'fail' || r.status === 'warn');
  log(`\nChecking again… ${report.counts.fail} error${report.counts.fail === 1 ? '' : 's'} · ${report.counts.warn} warning${report.counts.warn === 1 ? '' : 's'}`);
  for (const r of leftovers) {
    log(`  ${paint(r.status === 'fail' ? 31 : 33, r.status === 'fail' ? '✖' : '⚠')} ${r.title}`);
    if (r.fix) log(paint(2, `      fix: ${r.fix}`));
  }
  if (changed) log('\nRestart open Claude sessions to load the changes.');
  return exitCode(report);
}
