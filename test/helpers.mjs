// Test helpers: a fake machine and a fake context whose `run` answers from a table and whose
// filesystem is an in-memory map, so no test ever spawns a process or touches the disk.
// The JSON shapes match what Claude Code 2.1.328 prints (checked by hand, values made up).

import path from 'node:path';

export const HOME = '/home/dev';
export const CONFIG_FILE = `${HOME}/.config/rigup/config.json`;
export const DATA_DIR = `${HOME}/.local/share/rigup`;
export const LOCAL_MP_DIR = `${DATA_DIR}/marketplace`;
export const ACME_LOCATION = `${HOME}/.claude/plugins/marketplaces/acme-skills`;
export const MY_SKILLS = `${HOME}/work/my-skills`;
export const CLONE_HEAD = '1111111111111111111111111111111111111111';
export const REMOTE_HEAD = '2222222222222222222222222222222222222222';

export const ok = stdout => ({ status: 0, stdout, stderr: '' });
export const failed = (stderr = 'failed') => ({ status: 1, stdout: '', stderr });

export const MARKETPLACES = [
  { name: 'acme-skills', source: 'github', repo: 'acme/claude-skills', installLocation: ACME_LOCATION },
  { name: 'rigup-local', source: 'directory', path: LOCAL_MP_DIR, installLocation: LOCAL_MP_DIR },
];

const plugin = (id, extra = {}) => ({
  id, version: 'abc123def456', scope: 'user', enabled: true,
  installPath: `${HOME}/.claude/plugins/cache/${id.split('@')[1]}/${id.split('@')[0]}/abc123def456`,
  installedAt: '2026-11-01T10:00:00.000Z', lastUpdated: '2026-11-10T10:00:00.000Z', ...extra,
});

export const PLUGINS = [
  plugin('review@acme-skills'),
  plugin('release@acme-skills'),
  plugin('my-skills@rigup-local', { version: 'unknown' }),
  plugin('other@somewhere-else'),
];

export const ACME_CATALOG = {
  name: 'acme-skills',
  owner: { name: 'Acme' },
  plugins: [
    { name: 'review', source: './plugins/review' },
    { name: 'release', source: './plugins/release' },
    { name: 'docs', source: './plugins/docs' },
  ],
};

export const LOCAL_CATALOG = {
  name: 'rigup-local',
  owner: { name: 'rigup' },
  plugins: [{ name: 'my-skills', source: './plugins/my-skills' }],
};

/**
 * A machine with claude 2.1.328, the acme-skills marketplace (clone behind the remote, docs not
 * installed) and ~/work/my-skills linked into rigup-local. Override any command by key
 * ("cmd arg1 arg2"), any file by path (null = missing), and folder mtimes by path.
 */
export function fakeContext({ overrides = {}, files = {}, mtimes = {}, env = {}, nodeVersion = '24.11.0', config } = {}) {
  const calls = [];
  const writes = [];
  const ops = [];
  const defaults = {
    'claude --version': ok('2.1.328 (Claude Code)\n'),
    'claude plugin marketplace list --json': ok(JSON.stringify(MARKETPLACES, null, 2)),
    'claude plugin list --json': ok(JSON.stringify(PLUGINS, null, 2)),
    [`git -C ${ACME_LOCATION} rev-parse HEAD`]: ok(`${CLONE_HEAD}\n`),
    'git ls-remote git@github.com:acme/claude-skills.git HEAD': ok(`${REMOTE_HEAD}\tHEAD\n`),
    'gh --version': ok('gh version 2.80.0\n'),
    'gh auth status': ok('Logged in to github.com\n'),
  };
  const table = {
    [CONFIG_FILE]: JSON.stringify(config || { sources: [{ source: 'acme/claude-skills' }, { source: MY_SKILLS }] }),
    [path.join(ACME_LOCATION, '.claude-plugin/marketplace.json')]: JSON.stringify(ACME_CATALOG),
    [path.join(LOCAL_MP_DIR, '.claude-plugin/marketplace.json')]: JSON.stringify(LOCAL_CATALOG),
    [`${MY_SKILLS}/skills/hello/SKILL.md`]: '---\nname: hello\ndescription: Says hello.\n---\nHello.',
    [`${HOME}/.claude/settings.json`]: JSON.stringify({ extraKnownMarketplaces: { 'acme-skills': { autoUpdate: true } } }),
    ...files,
  };
  for (const [k, v] of Object.entries(table)) if (v === null) delete table[k];
  const isDir = p => Object.keys(table).some(f => f.startsWith(`${p}/`));

  return {
    calls, writes, ops, env, nodeVersion,
    home: HOME, cwd: `${HOME}/work`,
    configDir: `${HOME}/.claude`, configFile: CONFIG_FILE, dataDir: DATA_DIR, cacheDir: `${HOME}/.cache/rigup`,
    appDir: '/opt/rigup',
    run(cmd, args, opts) {
      const key = [cmd, ...args].join(' ');
      calls.push({ key, opts });
      if (key in overrides) return overrides[key];
      if (key in defaults) return defaults[key];
      return failed(`not found: ${key}`);
    },
    readFile: file => (file in table ? table[file] : null),
    writeFile(file, content) {
      writes.push({ file, content });
      table[file] = content;
    },
    stat(p) {
      if (p in table) return { isDir: false, isFile: true, isSymlink: false, mtimeMs: 0 };
      if (isDir(p)) return { isDir: true, isFile: false, isSymlink: false, mtimeMs: 0 };
      return null;
    },
    listDir(dir) {
      if (!isDir(dir)) return null;
      return [...new Set(Object.keys(table).filter(f => f.startsWith(`${dir}/`)).map(f => f.slice(dir.length + 1).split('/')[0]))].sort();
    },
    newestMtime: dir => (dir in mtimes ? mtimes[dir] : Date.parse('2026-11-05T00:00:00Z')),
    mkdir: dir => ops.push(`mkdir ${dir}`),
    remove: p => ops.push(`remove ${p}`),
    symlink: (target, link) => ops.push(`symlink ${link} -> ${target}`),
    copyDir: (from, to) => ops.push(`copy ${from} -> ${to}`),
  };
}
