#!/usr/bin/env node
// rigup: one command to set up Claude Code with your skills, agents and commands, from any
// marketplace repo or local folder, and keep every machine the same. See README.md.

import { readFileSync } from 'node:fs';
import { MIN_NODE_MAJOR } from './src/constants.mjs';
import { realContext } from './src/context.mjs';
import { doctor, exitCode, formatReport } from './src/doctor.mjs';
import { runAdd, runRemove, runSources } from './src/sources-command.mjs';
import { runSetup } from './src/setup-command.mjs';
import { runList, runSearch } from './src/catalog-command.mjs';
import { runChanges } from './src/changes-command.mjs';
import { appPathOf, checkForUpdate, findInstall, runUpdate } from './src/update.mjs';
import { completionScript, SHELLS, sourceNames } from './src/completion.mjs';
import { notifierPlan, readCheck, writeCheck } from './src/notifier.mjs';
import { runPrune } from './src/prune-command.mjs';

const HELP = `rigup · set up Claude Code with your skills, agents and commands

Usage:
  rigup add <source> [--plugins a,b]
                        Add a source: owner/repo[@ref], a git URL, or a folder
                        (a marketplace, a plugin folder, or a folder of <name>/SKILL.md)
  rigup remove <source> Remove a source from the config (installed plugins stay)
  rigup sources         List the configured sources
  rigup setup [--dry-run]
                        Apply the config: register sources, link local folders, turn on
                        auto-update, install missing plugins (safe to repeat)
  rigup update          Update rigup, every source and every plugin, then show what changed
  rigup doctor [--json] Check this machine against the config (read-only)
  rigup changes [--since 7d|2w|YYYY-MM-DD|<commit>] [--until YYYY-MM-DD] [--json]
                        New, updated, renamed and removed skills, agents and commands
  rigup list [--json]   Every skill, agent and command of your sources, with what it does
  rigup search <words> [--all] [--json]
                        Find skills, agents and commands by topic, and how to use them
  rigup prune [--days 28] [--yes] [--json]
                        Plugins of your sources you did not use lately (read locally from your
                        Claude transcripts); --yes uninstalls them and leaves them out of the config
  rigup completion zsh|bash|fish
                        Print a Tab-completion script (commands, and sources for rigup remove)
  rigup --version       Print the version (and the commit, for a git install)
  rigup --help          Show this help

Config: ~/.config/rigup/config.json (XDG_CONFIG_HOME respected; RIGUP_CONFIG overrides)`;

function version() {
  return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
}

async function main(argv) {
  // pnpm only warns about `engines`, so rigup says it clearly itself.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    console.error(`rigup needs Node ${MIN_NODE_MAJOR} or newer (this is Node ${process.versions.node}).`);
    return 1;
  }
  const [command, ...rest] = argv;
  const color = Boolean(process.stdout.isTTY);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    const install = findInstall(realContext());
    console.log(install && install.commit ? `${version()} (${install.commit.slice(0, 7)})` : version());
    return 0;
  }
  if (command === 'add') return runAdd(realContext(), rest);
  if (command === 'remove') return runRemove(realContext(), rest);
  if (command === 'sources') return runSources(realContext(), rest, { color });
  if (command === 'setup') return runSetup(realContext(), { dryRun: rest.includes('--dry-run'), color });
  if (command === 'update') return runUpdate(realContext(), { color });
  if (command === 'changes') return runChanges(realContext(), rest, { color });
  if (command === 'list') return runList(realContext(), rest, { color });
  if (command === 'search') return runSearch(realContext(), rest, { color });
  if (command === 'prune') return runPrune(realContext(), rest, { color });
  if (command === 'doctor') {
    const report = doctor(realContext());
    if (rest.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report, { color }));
    return exitCode(report);
  }
  if (command === 'completion') {
    const script = completionScript(rest[0]);
    if (!script) {
      console.error(`rigup completion: which shell? ${SHELLS.join(', ')} (e.g. source <(rigup completion zsh))`);
      return 2;
    }
    console.log(script);
    return 0;
  }
  // Plumbing, not in the help: Tab completion and the background update check.
  if (command === '__complete') {
    if (rest[0] === 'sources') console.log(sourceNames(realContext()).join('\n'));
    return 0;
  }
  if (command === '__check-update') {
    checkForUpdate(realContext());
    return 0;
  }
  console.error(`rigup: unknown command "${command}"\n\n${HELP}`);
  return 2;
}

/** After a command: the "rigup has updates" notice from the last check, and a new check once a day. */
function notifyUpdates(argv) {
  try {
    const ctx = realContext();
    const state = readCheck(ctx);
    const now = Date.now();
    const appPath = appPathOf(ctx);
    const plan = notifierPlan({ state, now, argv, env: process.env, isTTY: Boolean(process.stderr.isTTY && process.stdout.isTTY), appPath });
    if (plan.notice) console.error(`\n\x1b[33m${plan.notice}\x1b[0m`);
    if (plan.check) {
      // Stamp first, so a failing check (offline) runs once a day, not on every command.
      writeCheck(ctx, { checkedAt: now, appPath, installed: null, latest: null });
      ctx.spawnSelf(['__check-update']);
    }
  } catch {
    // The notice is a convenience; it never changes a command's result.
  }
}

const argv = process.argv.slice(2);
process.exitCode = await main(argv);
notifyUpdates(argv);
