// "rigup has updates" notice, the npm update-notifier way: never slows a command down.
//   - The last check lives in rigup's cache (update-check.json), keyed by the real folder of the
//     rigup that wrote it: the installed and latest version (npm) or commit (git install).
//   - Once a day a detached `rigup __check-update` refreshes it in the background.
//   - The notice is printed from the cached values, on stderr, after the command's own output.
// Quiet with --json, in a pipe, in CI, and with NO_UPDATE_NOTIFIER or RIGUP_NO_UPDATE_NOTIFIER.

import path from 'node:path';
import { compareVersions, parseJson } from './parse.mjs';

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const QUIET_COMMANDS = ['update', 'completion', '__complete', '__check-update', '--version', '-v'];

const file = ctx => path.join(ctx.cacheDir, 'update-check.json');

export function readCheck(ctx) {
  const data = parseJson(ctx.readFile(file(ctx)));
  return data && typeof data === 'object' ? data : {};
}

export function writeCheck(ctx, data) {
  try {
    ctx.writeFile(file(ctx), `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // No cache, no notice: never fail a command over it.
  }
}

/** True when the record says a newer rigup exists. */
export function isBehind(state) {
  if (!state.installed || !state.latest) return false;
  if (state.kind === 'npm') return compareVersions(state.latest, state.installed) > 0;
  return state.installed !== state.latest;
}

/** What to do after a command: { notice: string|null, check: boolean }. */
export function notifierPlan({ state, now, argv, env, isTTY, appPath = null }) {
  const command = argv[0];
  if (!isTTY || env.CI || env.NO_UPDATE_NOTIFIER || env.RIGUP_NO_UPDATE_NOTIFIER || argv.includes('--json') || !command || QUIET_COMMANDS.includes(command)) {
    return { notice: null, check: false };
  }
  // The record belongs to the rigup that wrote it. Another copy (a checkout, a reinstall) checks again.
  if (appPath && state.appPath !== appPath) return { notice: null, check: true };
  const check = !state.checkedAt || now - state.checkedAt > CHECK_EVERY_MS;
  if (!isBehind(state)) return { notice: null, check };
  const short = v => (state.kind === 'npm' ? v : v.slice(0, 7));
  const how = state.how || 'rigup update';
  return { notice: `rigup has updates (${short(state.installed)} → ${short(state.latest)}): run ${how}`, check };
}
