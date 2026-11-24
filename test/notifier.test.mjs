// Run: node --test test/*.test.mjs
//
// The "rigup has updates" notice and Tab completion: instant, and silent where nobody is looking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_EVERY_MS, isBehind, notifierPlan, readCheck } from '../src/notifier.mjs';
import { checkForUpdate } from '../src/update.mjs';
import { COMMANDS, completionScript, sourceNames } from '../src/completion.mjs';
import { fakeContext, failed, ok } from './helpers.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const NPM = { checkedAt: NOW - 1000, appPath: '/opt/rigup', kind: 'npm', installed: '0.3.0', latest: '0.3.1', how: 'rigup update' };
const plan = (over = {}) => notifierPlan({ state: NPM, now: NOW, argv: ['list'], env: {}, isTTY: true, appPath: '/opt/rigup', ...over });

test('npm install: notice only when the registry has a newer version', () => {
  assert.deepEqual(plan(), { notice: 'rigup has updates (0.3.0 → 0.3.1): run rigup update', check: false });
  assert.equal(isBehind({ ...NPM, latest: '0.3.0' }), false);
  // Running a newer local build than the registry is not "behind".
  assert.equal(isBehind({ ...NPM, installed: '0.4.0' }), false);
});

test('git install: commits differ; non-pnpm npm install: the npm command', () => {
  const git = { ...NPM, kind: 'git', installed: 'a'.repeat(40), latest: 'b'.repeat(40) };
  assert.equal(plan({ state: git }).notice, 'rigup has updates (aaaaaaa → bbbbbbb): run rigup update');
  assert.match(plan({ state: { ...NPM, how: 'npm install -g @sychusdev/rigup@latest' } }).notice, /run npm install -g @sychusdev\/rigup@latest/);
});

test('once a day; a record from another rigup is not trusted', () => {
  assert.equal(plan({ state: { ...NPM, checkedAt: NOW - CHECK_EVERY_MS - 1 } }).check, true);
  assert.deepEqual(plan({ appPath: '/elsewhere' }), { notice: null, check: true });
});

test('silent for pipes, --json, CI, NO_UPDATE_NOTIFIER, RIGUP_NO_UPDATE_NOTIFIER and plumbing', () => {
  const silent = { notice: null, check: false };
  assert.deepEqual(plan({ isTTY: false }), silent);
  assert.deepEqual(plan({ argv: ['list', '--json'] }), silent);
  for (const env of [{ CI: '1' }, { NO_UPDATE_NOTIFIER: '1' }, { RIGUP_NO_UPDATE_NOTIFIER: '1' }]) assert.deepEqual(plan({ env }), silent);
  for (const cmd of ['update', 'completion', '__complete', '__check-update', '--version']) assert.deepEqual(plan({ argv: [cmd] }), silent);
});

test('__check-update: npm -g install (not pnpm) records the npm version and the npm command', () => {
  const ctx = fakeContext({ overrides: { 'pnpm ls -g --json --depth=0': failed(), 'npm view @sychusdev/rigup version': ok('0.3.1\n') } });
  ctx.appDir = '/usr/local/lib/node_modules/@sychusdev/rigup';
  ctx.now = () => new Date(NOW);
  ctx.writeFile('/usr/local/lib/node_modules/@sychusdev/rigup/package.json', JSON.stringify({ version: '0.3.0' }));
  checkForUpdate(ctx);
  assert.deepEqual(readCheck(ctx), {
    checkedAt: NOW, appPath: '/usr/local/lib/node_modules/@sychusdev/rigup', kind: 'npm', installed: '0.3.0', latest: '0.3.1', how: 'npm install -g @sychusdev/rigup@latest',
  });
});

test('__check-update from a checkout: nothing to compare', () => {
  const ctx = fakeContext({ overrides: { 'pnpm ls -g --json --depth=0': failed() } });
  ctx.appDir = '/home/dev/src/rigup';
  ctx.now = () => new Date(NOW);
  checkForUpdate(ctx);
  assert.equal(readCheck(ctx).latest, null);
  assert.ok(!ctx.calls.some(c => c.key.startsWith('npm view')));
});

test('completion: every shell has every command, and sources come from the config only', () => {
  for (const shell of ['zsh', 'bash', 'fish']) {
    const script = completionScript(shell);
    for (const cmd of Object.keys(COMMANDS)) assert.ok(script.includes(cmd), `${shell} misses ${cmd}`);
    assert.match(script, /rigup __complete sources/);
  }
  assert.equal(completionScript('powershell'), null);
  const ctx = fakeContext();
  assert.deepEqual(sourceNames(ctx), ['acme/claude-skills', '~/work/my-skills']);
  assert.equal(ctx.calls.length, 0);
});
