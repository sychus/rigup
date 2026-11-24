// rigup doctor checks. Pure functions of (facts, env, resolved requirements): no I/O, so each
// rule is unit-tested. A result is { status, title, fix?, by? } with status ok | warn | fail | info.
// `by` names the rigup command that fixes it ('setup' or 'update'), so doctor only suggests a
// command that will actually do something. Only `fail` makes doctor exit non-zero.

import {
  FORCE_PLUGIN_UPDATES_VAR, LOCAL_MARKETPLACE, MIN_CLAUDE_VERSION, MIN_NODE_MAJOR, UPDATE_DISABLING_VARS,
} from './constants.mjs';
import { compareVersions, parseMcpGetStatus, shortSha } from './parse.mjs';

const ok = title => ({ status: 'ok', title });
const warn = (title, fix, by) => ({ status: 'warn', title, ...(fix ? { fix } : {}), ...(by ? { by } : {}) });
const fail = (title, fix, by) => ({ status: 'fail', title, ...(fix ? { fix } : {}), ...(by ? { by } : {}) });
const info = title => ({ status: 'info', title });

const KIND_LABEL = {
  remote: 'marketplace repo', marketplace: 'local marketplace', plugin: 'local plugin folder',
  flat: 'local skills folder', missing: 'folder not found', empty: 'empty folder',
};

// More plugins than this taken with "*" gets a hint to pick some (public catalogs have hundreds).
export const LARGE_CATALOG = 25;

export function checkNode(facts) {
  const major = facts.node ? Number(facts.node.split('.')[0]) : NaN;
  if (!(major >= MIN_NODE_MAJOR)) {
    return [fail(`node ${facts.node || '(unknown)'} is older than ${MIN_NODE_MAJOR}`, `install Node ${MIN_NODE_MAJOR}+ (https://nodejs.org or your version manager)`)];
  }
  return [ok(`node ${facts.node} (minimum ${MIN_NODE_MAJOR})`)];
}

export function checkClaude(facts) {
  if (!facts.claude.installed) {
    return [fail('claude is not installed', 'install Claude Code: https://code.claude.com/docs')];
  }
  const { version } = facts.claude;
  if (!version || compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    return [fail(`claude ${version || '(unknown version)'} is older than ${MIN_CLAUDE_VERSION}`, 'claude update')];
  }
  return [ok(`claude ${version} (minimum ${MIN_CLAUDE_VERSION})`)];
}

/** True when the user settings already force plugin updates on. */
export function forcesPluginUpdates(facts) {
  const env = (facts.userSettings && facts.userSettings.env) || {};
  return env[FORCE_PLUGIN_UPDATES_VAR] === '1';
}

export function checkUpdateEnv(facts, env) {
  const disabling = UPDATE_DISABLING_VARS.filter(k => isTruthy(env[k]));
  if (!disabling.length) return [];
  if (env[FORCE_PLUGIN_UPDATES_VAR] === '1' || forcesPluginUpdates(facts)) {
    return [ok(`${disabling.join(', ')} set, but ${FORCE_PLUGIN_UPDATES_VAR}=1 keeps plugin updates on`)];
  }
  return [warn(`${disabling.join(', ')} set: plugin auto-update is off`, `rigup setup (sets ${FORCE_PLUGIN_UPDATES_VAR}=1 in your Claude settings)`, 'setup')];
}

export function checkConfig(facts, configFile) {
  const { errors, sources, exists } = facts.config;
  if (errors.length) return errors.map(e => fail(e, `fix ${configFile}`));
  if (!sources.length) {
    return [fail(
      exists ? 'no sources in the config' : 'no config yet',
      'rigup add <owner/repo | git URL | folder>',
    )];
  }
  const results = [ok(`${sources.length} source${sources.length === 1 ? '' : 's'} in ${configFile}`)];
  // Two local folders with the same name would be the same plugin in rigup-local.
  const byName = new Map();
  for (const s of facts.sources) {
    if (!s.pluginName) continue;
    byName.set(s.pluginName, [...(byName.get(s.pluginName) || []), s.label]);
  }
  for (const [name, labels] of byName) {
    if (labels.length > 1) {
      results.push(fail(`${labels.join(' and ')} would both be plugin "${name}"`, 'rename one folder, or give it a .claude-plugin/plugin.json with another "name"'));
    }
  }
  return results;
}

/** Checks for one source; returns { title, results }. */
export function checkSource(s, facts) {
  const results = [];
  const title = `${s.label}  (${KIND_LABEL[s.kind] || s.kind})`;

  if (s.kind === 'missing') {
    return { title, results: [fail(`${s.spec.path} does not exist`, `fix the path, or rigup remove ${s.label}`)] };
  }
  if (s.kind === 'empty') {
    return { title, results: [fail('no skills, agents, commands or marketplace in this folder', 'add <name>/SKILL.md folders, or point at the right folder')] };
  }

  if (s.kind === 'remote') {
    if (s.access && s.access.ok) {
      results.push(ok(`reachable without a prompt (${s.access.url})`));
    } else if (s.access) {
      const canFix = s.spec.type === 'github' && facts.gh.authenticated;
      results.push(fail(
        'no git access without a prompt: Claude Code cannot install or update it',
        s.spec.type === 'github' ? (canFix ? 'rigup setup (runs gh auth setup-git)' : 'gh auth login && gh auth setup-git') : 'set up an SSH key or a credential helper for this host',
        canFix ? 'setup' : undefined,
      ));
    }
  }

  if (s.kind === 'remote' || s.kind === 'marketplace') {
    if (!s.marketplace) {
      results.push(fail('not registered in Claude Code', 'rigup setup', 'setup'));
      return { title, results };
    }
    results.push(ok(`registered as marketplace "${s.marketplace.name}"`));
    if (!s.catalog) {
      results.push(warn('cannot read its catalog (.claude-plugin/marketplace.json)', 'rigup setup', 'setup'));
    }
    if (s.kind === 'remote' && s.cloneHead && s.access && s.access.head) {
      if (s.cloneHead !== s.access.head) {
        results.push(warn(`behind the remote (${shortSha(s.cloneHead)} → ${shortSha(s.access.head)})`, 'rigup update', 'update'));
      } else {
        results.push(ok(`current (${shortSha(s.cloneHead)})`));
      }
    }
    if (s.kind === 'remote') {
      const entry = ((facts.userSettings && facts.userSettings.extraKnownMarketplaces) || {})[s.marketplace.name] || {};
      if (entry.autoUpdate === true && entry.source) results.push(ok('auto-update on'));
      else if (entry.autoUpdate === true) results.push(warn('auto-update is set without the marketplace source, so Claude Code ignores it', 'rigup setup', 'setup'));
      else results.push(warn('auto-update off (Claude Code\'s default for third-party marketplaces)', 'rigup setup', 'setup'));
    }
  }

  if (s.kind === 'plugin' || s.kind === 'flat') {
    const lm = facts.localMarketplace;
    const from = lm && lm.registered && (lm.registered.path || lm.registered.installLocation);
    if (from && lm.dir && from !== lm.dir) {
      results.push(fail(`${LOCAL_MARKETPLACE} is registered from ${from}, not rigup's ${lm.dir}`, `claude plugin marketplace remove ${LOCAL_MARKETPLACE}, then rigup setup`));
      return { title, results };
    }
    if (!s.marketplace || !s.inLocalMarketplace) {
      results.push(fail(`not linked into the ${LOCAL_MARKETPLACE} marketplace`, 'rigup setup', 'setup'));
      return { title, results };
    }
    results.push(ok(`linked as plugin "${s.pluginName}" in ${LOCAL_MARKETPLACE}`));
    // Claude Code installs a copy: edits to the folder need a refresh to reach sessions.
    const installed = s.installed[0];
    const synced = installed && Date.parse(installed.lastUpdated || installed.installedAt || '');
    if (installed && s.newestMtime && synced && s.newestMtime > synced) {
      results.push(warn('edited since the installed copy was made: sessions still see the old version', 'rigup update', 'update'));
    }
  }

  results.push(...checkSourcePlugins(s));
  return { title, results };
}

export function checkSourcePlugins(s) {
  const results = [];
  const installed = new Map(s.installed.map(p => [p.id.split('@')[0], p]));
  const unknown = s.wanted.filter(name => !s.available.includes(name));
  if (unknown.length && s.catalog) {
    results.push(warn(`not in this source's catalog: ${unknown.join(', ')}`, 'fix "plugins" for this source in the config'));
  }
  const wanted = s.wanted.filter(name => s.available.includes(name));
  const missing = wanted.filter(name => !installed.has(name));
  const disabled = wanted.filter(name => installed.has(name) && installed.get(name).enabled === false);
  if (missing.length) {
    results.push(fail(`not installed: ${missing.join(', ')}`, 'rigup setup', 'setup'));
  }
  for (const name of disabled) {
    results.push(fail(`${name}: installed but disabled`, `claude plugin enable ${name}@${s.marketplaceName}`));
  }
  if (!missing.length && !disabled.length && wanted.length) {
    results.push(ok(`${wanted.length} plugin${wanted.length === 1 ? '' : 's'} installed and enabled`));
  }
  if (s.selection === '*' && !s.pluginName && s.available.length > LARGE_CATALOG) {
    results.push(info(`taking all ${s.available.length} plugins of this catalog; pick some with "plugins": [...] in the config`));
  }
  return results;
}

export function checkRequirements(resolved) {
  if (!resolved.length) return [info('no installed plugin declares requirements (requirements.json)')];
  // Findings are grouped: the same gap reported by several plugins shows once, listing them all.
  const groups = new Map();
  const add = (plugin, result) => {
    const key = `${result.status}|${result.title}|${result.fix || ''}`;
    if (!groups.has(key)) groups.set(key, { ...result, plugins: [] });
    groups.get(key).plugins.push(plugin);
  };
  for (const r of resolved) {
    // Required and missing: an error. Optional (one skill needs it) and missing: info only, so
    // people who never use that skill are not told to fix something they do not need.
    for (const t of r.tools) {
      if (t.present) continue;
      if (t.optional) add(r.plugin, info(`${t.name} not found${usedBy(t)} · install when needed: ${t.install || t.name}`));
      else add(r.plugin, fail(`needs ${t.name}${t.why ? ` (${t.why})` : ''}`, t.install || `install ${t.name}`));
    }
    for (const e of r.env) {
      if (e.present) continue;
      if (e.optional) add(r.plugin, info(`${e.name} not set${usedBy(e)}${e.where ? ` · ${e.where}` : ''}`));
      else add(r.plugin, fail(`${e.name} is not set${e.why ? ` (${e.why})` : ''}`, e.where || `set ${e.name}`));
    }
    for (const c of r.connectors) {
      if (!c.found) {
        if (c.optional) add(r.plugin, info(`connector "${c.name}" not found${usedBy(c)}`));
        else add(r.plugin, fail(`connector "${c.name}" not found`, 'add the MCP server (claude mcp add, or a claude.ai connector) and authorize it'));
        continue;
      }
      if (c.found !== c.name) {
        add(r.plugin, warn(`"${c.name}" found as "${c.found}": tool names (mcp__<name>__*) will not match what the skills call`, `rename the connector to "${c.name}"`));
      }
      const status = parseMcpGetStatus(c.output);
      if (status === 'needs-auth') add(r.plugin, warn(`connector "${c.found}" needs authentication`, `authorize it (claude mcp get "${c.found}")`));
      else if (status === 'failed') add(r.plugin, warn(`connector "${c.found}" failed to connect`, `claude mcp get "${c.found}"`));
    }
  }
  const results = [...groups.values()].map(({ plugins, ...result }) => ({ ...result, title: `${plugins.join(', ')}: ${result.title}` }));
  if (!results.some(r => r.status !== 'info')) results.unshift(ok('all required tools, variables and connectors are present'));
  return results;
}

/** All sections, in display order. */
export function runChecks(facts, env, resolved, { configFile = 'the config' } = {}) {
  const sections = [
    { title: 'Claude Code', results: [...checkNode(facts), ...checkClaude(facts), ...checkUpdateEnv(facts, env)] },
    { title: 'Config', results: checkConfig(facts, configFile) },
  ];
  for (const s of facts.sources) {
    const { title, results } = checkSource(s, facts);
    sections.push({ title: `Source ${title}`, results });
  }
  if (facts.sources.length) sections.push({ title: 'Requirements', results: checkRequirements(resolved) });
  return sections;
}

function usedBy(item) {
  return item.usedBy && item.usedBy.length ? ` (used by ${[].concat(item.usedBy).join(', ')})` : '';
}

export function isTruthy(value) {
  return value !== undefined && value !== '' && value !== '0' && String(value).toLowerCase() !== 'false';
}
