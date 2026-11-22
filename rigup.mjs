#!/usr/bin/env node
// rigup: one command to set up Claude Code with your skills, agents and commands, from any
// marketplace repo or local folder, and keep every machine the same. See README.md.

import { readFileSync } from 'node:fs';
import { MIN_NODE_MAJOR } from './src/constants.mjs';
import { realContext } from './src/context.mjs';
import { doctor, exitCode, formatReport } from './src/doctor.mjs';
import { runAdd, runRemove, runSources } from './src/sources-command.mjs';
import { runSetup } from './src/setup-command.mjs';

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
  rigup doctor [--json] Check this machine against the config (read-only)
  rigup --version       Print the version
  rigup --help          Show this help

Config: ~/.config/rigup/config.json (XDG_CONFIG_HOME respected; RIGUP_CONFIG overrides)`;

// Commands on the roadmap: say so instead of "unknown command".
const PLANNED = ['update', 'changes', 'list', 'search'];

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
    console.log(version());
    return 0;
  }
  if (command === 'add') return runAdd(realContext(), rest);
  if (command === 'remove') return runRemove(realContext(), rest);
  if (command === 'sources') return runSources(realContext(), rest, { color });
  if (command === 'setup') return runSetup(realContext(), { dryRun: rest.includes('--dry-run'), color });
  if (command === 'doctor') {
    const report = doctor(realContext());
    if (rest.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report, { color }));
    return exitCode(report);
  }
  if (PLANNED.includes(command)) {
    console.error(`rigup: "${command}" is on the roadmap but not built yet.\n\n${HELP}`);
    return 2;
  }
  console.error(`rigup: unknown command "${command}"\n\n${HELP}`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
