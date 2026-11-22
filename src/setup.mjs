// rigup setup: brings this machine to what the config describes. Split in two:
//   planSetup(facts, env) -> ordered actions (pure, unit-tested: every decision lives here)
//   applySetup(ctx, plan) -> runs them, stopping at the first failed step
// Idempotent: when nothing is missing the plan is empty and setup says so.

import path from 'node:path';
import {
  FORCE_PLUGIN_UPDATES_VAR, LOCAL_MARKETPLACE, MIN_CLAUDE_VERSION, MIN_NODE_MAJOR, UPDATE_DISABLING_VARS,
} from './constants.mjs';
import { forcesPluginUpdates, isTruthy } from './checks.mjs';
import { gatherFacts } from './facts.mjs';
import { localEntries, writeLocalMarketplace } from './local-marketplace.mjs';
import { compareVersions, parseJson } from './parse.mjs';
import { marketplaceAddArg } from './sources.mjs';

/**
 * An action is one of:
 *   { kind: 'stop', title, fix }                      blocking problem rigup cannot fix for you
 *   { kind: 'hint', title, fix }                      shown, not run (e.g. a source that is skipped)
 *   { kind: 'run', title, cmd, args }                 a command
 *   { kind: 'local-marketplace', title, dir, register } rebuild rigup-local and register or refresh it
 *   { kind: 'settings', title, sources, force }       auto-update for these sources (names resolved
 *                                                     after registration), FORCE_AUTOUPDATE_PLUGINS
 *   { kind: 'install', title }                        wanted plugins not installed (resolved last)
 */
export function planSetup(facts, env) {
  const actions = [];
  const nodeMajor = facts.node ? Number(facts.node.split('.')[0]) : 0;
  if (nodeMajor < MIN_NODE_MAJOR) {
    actions.push({ kind: 'stop', title: `Node ${facts.node || '?'} is older than ${MIN_NODE_MAJOR}`, fix: `install Node ${MIN_NODE_MAJOR}+` });
  }
  if (!facts.claude.installed) {
    actions.push({ kind: 'stop', title: 'Claude Code is not installed', fix: 'install it: https://code.claude.com/docs' });
  } else if (!facts.claude.version || compareVersions(facts.claude.version, MIN_CLAUDE_VERSION) < 0) {
    actions.push({ kind: 'stop', title: `claude ${facts.claude.version || '?'} is older than ${MIN_CLAUDE_VERSION}`, fix: 'claude update' });
  }
  if (facts.config.errors.length) {
    actions.push({ kind: 'stop', title: `the config has errors: ${facts.config.errors[0]}`, fix: 'rigup doctor lists them all' });
  } else if (!facts.config.sources.length) {
    actions.push({ kind: 'stop', title: 'no sources yet', fix: 'rigup add <owner/repo | git URL | folder>' });
  }
  if (actions.length) return actions;

  const names = new Map();
  for (const s of facts.sources) if (s.pluginName) names.set(s.pluginName, (names.get(s.pluginName) || 0) + 1);
  const clash = [...names].find(([, n]) => n > 1);
  if (clash) return [{ kind: 'stop', title: `two local folders would both be plugin "${clash[0]}"`, fix: 'rename one folder (rigup doctor shows which)' }];

  // Sources rigup cannot use are skipped, not fatal: the rest still gets set up.
  const usable = [];
  let setupGit = false;
  for (const s of facts.sources) {
    if (s.kind === 'missing' || s.kind === 'empty') {
      actions.push({ kind: 'hint', title: `skipped ${s.label}: ${s.kind === 'missing' ? 'folder not found' : 'nothing to install in it'}`, fix: 'rigup doctor' });
      continue;
    }
    if (s.kind === 'remote' && s.access && !s.access.ok) {
      if (s.spec.type === 'github' && facts.gh.authenticated) {
        setupGit = true;
      } else {
        actions.push({
          kind: 'hint',
          title: `skipped ${s.label}: no git access without a prompt`,
          fix: s.spec.type === 'github' ? 'gh auth login && gh auth setup-git, then rigup setup' : 'set up an SSH key or credential helper, then rigup setup',
        });
        continue;
      }
    }
    usable.push(s);
  }
  if (setupGit) {
    actions.push({ kind: 'run', title: 'store git credentials for github.com (gh auth setup-git)', cmd: 'gh', args: ['auth', 'setup-git'] });
  }

  // Marketplaces: register what is missing; refresh what we cannot read the catalog of.
  let registers = false;
  for (const s of usable.filter(x => x.kind === 'remote' || x.kind === 'marketplace')) {
    if (!s.marketplace) {
      registers = true;
      actions.push({
        kind: 'run', title: `register ${s.label} as a marketplace`,
        cmd: 'claude', args: ['plugin', 'marketplace', 'add', marketplaceAddArg(s.spec), '--scope', 'user', '--json'],
      });
    } else if (!s.catalog) {
      actions.push({
        kind: 'run', title: `refresh the ${s.marketplace.name} marketplace`,
        cmd: 'claude', args: ['plugin', 'marketplace', 'update', s.marketplace.name, '--json'],
      });
    }
  }

  // Local plugin and flat folders go into rigup-local.
  const locals = usable.filter(s => s.kind === 'plugin' || s.kind === 'flat');
  if (locals.length) {
    const lm = facts.localMarketplace;
    const elsewhere = lm.registered && path.resolve(lm.registered.path || lm.registered.installLocation || '') !== lm.dir;
    if (elsewhere) {
      actions.push({
        kind: 'hint',
        title: `skipped local folders: ${LOCAL_MARKETPLACE} is registered from ${lm.registered.path || lm.registered.installLocation}, not ${lm.dir}`,
        fix: `claude plugin marketplace remove ${LOCAL_MARKETPLACE}, then rigup setup`,
      });
    } else if (!lm.registered || locals.some(s => !s.inLocalMarketplace)) {
      registers = registers || !lm.registered;
      actions.push({
        kind: 'local-marketplace',
        title: `${lm.registered ? 'refresh' : 'create'} the ${LOCAL_MARKETPLACE} marketplace (${locals.map(s => s.label).join(', ')})`,
        dir: lm.dir,
        register: !lm.registered,
      });
    }
  }

  // Auto-update for remote sources (Claude Code defaults it to off for third-party marketplaces),
  // and FORCE_AUTOUPDATE_PLUGINS when a variable in this shell switches plugin updates off.
  const settings = facts.userSettings || {};
  const known = settings.extraKnownMarketplaces || {};
  const remotes = usable.filter(s => s.kind === 'remote');
  const needAuto = remotes.filter(s => !s.marketplace || !(known[s.marketplace.name] && known[s.marketplace.name].autoUpdate === true));
  const force = UPDATE_DISABLING_VARS.some(k => isTruthy(env[k])) && env[FORCE_PLUGIN_UPDATES_VAR] !== '1' && !forcesPluginUpdates(facts);
  if (needAuto.length || force) {
    actions.push({
      kind: 'settings',
      title: [needAuto.length && `turn on auto-update for ${needAuto.map(s => s.label).join(', ')}`, force && `set ${FORCE_PLUGIN_UPDATES_VAR}=1`].filter(Boolean).join('; '),
      sources: needAuto.map(s => s.id),
      force,
    });
  }

  // Plugins last, resolved after the marketplaces exist, so new catalogs are included.
  const missing = usable.some(s => s.wanted.some(name => s.available.includes(name) && !s.installed.some(p => p.id.split('@')[0] === name)));
  if (registers || missing || actions.some(a => a.kind === 'local-marketplace')) {
    actions.push({ kind: 'install', title: 'install the plugins this machine is missing' });
  }
  return actions;
}

/** Deep-merges `patch` into `target` without dropping existing keys. Returns a new object. */
export function mergeSettings(target, patch) {
  const out = { ...(target || {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeSettings(out[key] && typeof out[key] === 'object' ? out[key] : {}, value)
      : value;
  }
  return out;
}

/** Wanted plugins not installed yet, per source: [{ id, label }] ("name@marketplace"). */
export function missingPlugins(facts) {
  const out = [];
  for (const s of facts.sources) {
    if (!s.marketplaceName) continue;
    for (const name of s.wanted) {
      if (!s.available.includes(name)) continue;
      if (s.installed.some(p => p.id.split('@')[0] === name)) continue;
      out.push({ id: `${name}@${s.marketplaceName}`, label: s.label });
    }
  }
  return out;
}

/**
 * Runs the plan. Returns { steps: [{ title, status: done|failed|hint|stop|planned, detail }], changed }.
 * `dryRun` describes every step without running anything. `onStep` prints each step as it happens.
 */
export function applySetup(ctx, actions, { dryRun = false, facts, onStep = null } = {}) {
  const steps = [];
  const record = step => { steps.push(step); if (onStep) onStep(step); };
  const failedStep = (title, res) => record({ title, status: 'failed', detail: lastLine(res.stderr) || lastLine(res.stdout) || `exit ${res.status}` });
  let changed = false;

  for (const action of actions) {
    if (action.kind === 'stop' || action.kind === 'hint') {
      record({ title: action.title, status: action.kind, detail: action.fix });
      if (action.kind === 'stop') return { steps, changed };
      continue;
    }
    if (dryRun) {
      record({ title: action.title, status: 'planned', detail: describe(action, facts) });
      continue;
    }

    if (action.kind === 'run') {
      const res = ctx.run(action.cmd, action.args, { timeout: 180000 });
      if (res.status !== 0) { failedStep(action.title, res); return { steps, changed }; }
      record({ title: action.title, status: 'done' });
      changed = true;
      continue;
    }

    if (action.kind === 'local-marketplace') {
      // Re-read the sources, so a folder fixed since planning is included.
      const entries = localEntries(gatherFacts(ctx, { checkAccess: false }));
      try {
        writeLocalMarketplace(ctx, action.dir, entries);
      } catch (err) {
        record({ title: action.title, status: 'failed', detail: err.message });
        return { steps, changed };
      }
      const args = action.register
        ? ['plugin', 'marketplace', 'add', action.dir, '--scope', 'user', '--json']
        : ['plugin', 'marketplace', 'update', LOCAL_MARKETPLACE, '--json'];
      const res = ctx.run('claude', args, { timeout: 180000 });
      if (res.status !== 0) { failedStep(action.title, res); return { steps, changed }; }
      record({ title: action.title, status: 'done' });
      changed = true;
      continue;
    }

    if (action.kind === 'settings') {
      const now = gatherFacts(ctx, { checkAccess: false });
      const marketplaces = now.sources.filter(s => action.sources.includes(s.id) && s.marketplace).map(s => s.marketplace.name);
      const patch = {};
      if (marketplaces.length) patch.extraKnownMarketplaces = Object.fromEntries(marketplaces.map(n => [n, { autoUpdate: true }]));
      if (action.force) patch.env = { [FORCE_PLUGIN_UPDATES_VAR]: '1' };
      if (!Object.keys(patch).length) continue;
      const file = path.join(ctx.configDir, 'settings.json');
      const raw = ctx.readFile(file);
      const current = raw === null ? {} : parseJson(raw);
      if (current === null) {
        record({ title: action.title, status: 'failed', detail: `${file} is not valid JSON; fix it by hand, rigup will not overwrite it` });
        return { steps, changed };
      }
      ctx.writeFile(file, `${JSON.stringify(mergeSettings(current, patch), null, 2)}\n`);
      record({ title: action.title, status: 'done' });
      changed = true;
      continue;
    }

    if (action.kind === 'install') {
      for (const { id } of missingPlugins(gatherFacts(ctx, { checkAccess: false }))) {
        const res = ctx.run('claude', ['plugin', 'install', id, '--scope', 'user', '--json'], { timeout: 180000 });
        if (res.status !== 0) { failedStep(`install ${id}`, res); return { steps, changed }; }
        record({ title: `install ${id}`, status: 'done' });
        changed = true;
      }
    }
  }
  return { steps, changed };
}

function describe(action, facts) {
  if (action.kind === 'run') return `${action.cmd} ${action.args.join(' ')}`;
  if (action.kind === 'local-marketplace') return `${action.dir}, then claude plugin marketplace ${action.register ? 'add' : 'update'}`;
  if (action.kind === 'settings') return `merge into ${'settings.json'}: autoUpdate${action.force ? `, ${FORCE_PLUGIN_UPDATES_VAR}=1` : ''}`;
  if (action.kind === 'install') {
    const known = missingPlugins(facts).map(m => m.id);
    return known.length ? `would install: ${known.join(', ')} (plus anything a new marketplace brings)` : 'list resolved after the marketplace steps';
  }
  return '';
}

function lastLine(text) {
  const lines = (text || '').trim().split('\n');
  return lines[lines.length - 1];
}
