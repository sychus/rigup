// `rigup add`, `rigup remove` and `rigup sources`: edit and show the config.
// They only touch rigup's config file; `rigup setup` applies it to Claude Code.

import { addSource, loadConfig, removeSource, saveConfig } from './config.mjs';
import { label } from './sources.mjs';

/** Value after a flag (`--plugins a,b`), or null. */
export function flagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

/** Positional arguments (not flags, not flag values). */
export function positionals(args, flagsWithValue = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValue.includes(args[i])) { i++; continue; }
    if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

function loadRaw(ctx, error) {
  const config = loadConfig(ctx);
  if (config.raw === null) {
    error(`rigup: ${config.errors[0]}; fix it by hand, rigup will not overwrite it`);
    return null;
  }
  return config.raw;
}

export function runAdd(ctx, args, { log = console.log, error = console.error } = {}) {
  const [input] = positionals(args, ['--plugins']);
  if (!input) {
    error('rigup add: what should I add? e.g. rigup add acme/claude-skills, or rigup add ~/my-skills');
    return 2;
  }
  const pluginsFlag = flagValue(args, '--plugins');
  const plugins = pluginsFlag ? pluginsFlag.split(',').map(p => p.trim()).filter(Boolean) : null;
  const raw = loadRaw(ctx, error);
  if (!raw) return 1;
  try {
    const next = addSource(raw, input, { plugins, home: ctx.home, cwd: ctx.cwd });
    saveConfig(ctx, next);
    const added = next.sources[next.sources.length - 1].source;
    log(`Added ${added}${plugins ? ` (plugins: ${plugins.join(', ')})` : ''} to ${ctx.configFile}.`);
    log('Run `rigup setup` to install it.');
    return 0;
  } catch (err) {
    error(`rigup add: ${err.message}`);
    return 1;
  }
}

export function runRemove(ctx, args, { log = console.log, error = console.error } = {}) {
  const [input] = positionals(args);
  if (!input) {
    error('rigup remove: which source? See rigup sources');
    return 2;
  }
  const raw = loadRaw(ctx, error);
  if (!raw) return 1;
  try {
    saveConfig(ctx, removeSource(raw, input, { home: ctx.home, cwd: ctx.cwd }));
    log(`Removed ${input} from ${ctx.configFile}. Its installed plugins stay; remove them with claude plugin uninstall.`);
    return 0;
  } catch (err) {
    error(`rigup remove: ${err.message}`);
    return 1;
  }
}

export function runSources(ctx, args, { log = console.log, error = console.error } = {}) {
  const config = loadConfig(ctx);
  if (config.errors.length) {
    for (const e of config.errors) error(`rigup: ${e}`);
    return 1;
  }
  if (args.includes('--json')) {
    log(JSON.stringify(config.sources.map(s => ({ source: s.spec.id, type: s.spec.type, plugins: s.plugins, exclude: s.exclude })), null, 2));
    return 0;
  }
  if (!config.sources.length) {
    log(`No sources yet (${ctx.configFile}).\nAdd one: rigup add <owner/repo | git URL | folder>`);
    return 0;
  }
  log(`rigup sources · ${ctx.configFile}\n`);
  for (const s of config.sources) {
    const plugins = s.plugins === '*'
      ? `all plugins${s.exclude.length ? ` except ${s.exclude.join(', ')}` : ''}`
      : s.plugins.join(', ');
    log(`  ${label(s.spec, ctx.home)}  (${s.spec.type}) · ${plugins}`);
  }
  return 0;
}
