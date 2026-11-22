// rigup-local: the marketplace rigup generates for local folders that are not marketplaces.
//
// Claude Code only accepts plugin sources inside the marketplace folder ("./..."), and it follows
// a symlinked plugin folder but not symlinks nested inside one. So:
//   plugin folder (skills/, agents/, commands/)  -> plugins/<name> is a symlink to the folder
//   flat folder (<skill>/SKILL.md)               -> plugins/<name>/skills/<skill> are copies
// The folder lives in rigup's data dir and rigup owns it: it is rebuilt on every sync.
// Removing it never touches your folders (removing a symlink removes the link only).

import path from 'node:path';
import { CATALOG_PATH, LOCAL_MARKETPLACE } from './constants.mjs';

/** The marketplace.json for the local sources ({ name, path, kind }). Pure. */
export function buildLocalCatalog(entries) {
  return {
    name: LOCAL_MARKETPLACE,
    owner: { name: 'rigup' },
    description: 'Local folders linked by rigup (https://github.com/sychus/rigup). Rebuilt by rigup setup and rigup update.',
    plugins: entries.map(e => ({
      name: e.name,
      source: `./plugins/${e.name}`,
      description: `${e.kind === 'flat' ? 'Skills copied' : 'Linked'} from ${e.path}`,
    })),
  };
}

/** Skill folders (with a SKILL.md) directly under a flat folder. */
export function flatSkills(ctx, folder) {
  return (ctx.listDir(folder) || []).filter(name => !name.startsWith('.') && ctx.stat(path.join(folder, name, 'SKILL.md')) !== null);
}

/**
 * Rebuilds the generated marketplace folder from the local sources. Returns the number of
 * plugins written. Throws if the folder cannot be written.
 */
export function writeLocalMarketplace(ctx, dir, entries) {
  const plugins = path.join(dir, 'plugins');
  ctx.remove(plugins);
  ctx.mkdir(plugins);
  for (const e of entries) {
    const target = path.join(plugins, e.name);
    if (e.kind === 'flat') {
      for (const skill of flatSkills(ctx, e.path)) ctx.copyDir(path.join(e.path, skill), path.join(target, 'skills', skill));
    } else {
      ctx.symlink(e.path, target);
    }
  }
  ctx.writeFile(path.join(dir, CATALOG_PATH), `${JSON.stringify(buildLocalCatalog(entries), null, 2)}\n`);
  return entries.length;
}

/** Local plugin and flat sources from facts, as entries for the generated marketplace. */
export function localEntries(facts) {
  return facts.sources
    .filter(s => s.kind === 'plugin' || s.kind === 'flat')
    .map(s => ({ name: s.pluginName, path: s.spec.path, kind: s.kind }));
}
