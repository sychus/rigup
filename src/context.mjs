// The real context: the only place rigup touches the process, the shell and the filesystem.
// Tests build their own context with fixtures instead (test/helpers.mjs).

import { spawnSync } from 'node:child_process';
import {
  cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules']);

export function realContext() {
  const home = homedir();
  const xdg = (name, fallback) => process.env[name] || path.join(home, fallback);
  return {
    env: process.env,
    nodeVersion: process.versions.node,
    home,
    cwd: process.cwd(),
    // Claude Code honors CLAUDE_CONFIG_DIR instead of ~/.claude.
    configDir: process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    // rigup's own files, XDG style. RIGUP_CONFIG points at another config file.
    configFile: process.env.RIGUP_CONFIG || path.join(xdg('XDG_CONFIG_HOME', '.config'), 'rigup', 'config.json'),
    dataDir: path.join(xdg('XDG_DATA_HOME', '.local/share'), 'rigup'),
    cacheDir: path.join(xdg('XDG_CACHE_HOME', '.cache'), 'rigup'),
    // Folder rigup.mjs runs from: `rigup update` finds how it was installed from here.
    appDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),

    run(cmd, args, { timeout = 30000, env = {} } = {}) {
      const res = spawnSync(cmd, args, {
        encoding: 'utf8',
        timeout,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
    },
    readFile(file) {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    // Atomic write: a crash mid-write never leaves a half-written settings.json.
    writeFile(file, content) {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.rigup-${process.pid}.tmp`;
      writeFileSync(tmp, content);
      renameSync(tmp, file);
    },
    /** { isDir, isFile, isSymlink, mtimeMs } (following symlinks), or null when missing. */
    stat(target) {
      try {
        const st = statSync(target);
        let isSymlink = false;
        try { isSymlink = lstatSync(target).isSymbolicLink(); } catch { /* ignore */ }
        return { isDir: st.isDirectory(), isFile: st.isFile(), isSymlink, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    },
    /** Names in a folder, or null when it cannot be read. */
    listDir(dir) {
      try {
        return readdirSync(dir).sort();
      } catch {
        return null;
      }
    },
    /** Newest modification time of any file under dir (skipping .git and node_modules), or null. */
    newestMtime(dir) {
      let newest = null;
      const walk = (d, depth) => {
        if (depth > 12) return;
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP_DIRS.has(e.name)) continue;
          const full = path.join(d, e.name);
          let st;
          try { st = statSync(full); } catch { continue; }
          if (st.isDirectory()) walk(full, depth + 1);
          else if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
        }
      };
      walk(dir, 0);
      return newest;
    },
    mkdir(dir) {
      mkdirSync(dir, { recursive: true });
    },
    remove(target) {
      rmSync(target, { recursive: true, force: true });
    },
    symlink(target, link) {
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(target, link, 'dir');
    },
    copyDir(from, to) {
      cpSync(from, to, { recursive: true, dereference: true, filter: src => !SKIP_DIRS.has(path.basename(src)) });
    },
  };
}
