// Run: node --test test/*.test.mjs
//
// rigup update against the fake machine: never runs pnpm, npm, git or claude for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInstall, gitSpecTarget, isGitSpec, lockCommit, runUpdate, updateSelf } from '../src/update.mjs';
import { ACME_LOCATION, CLONE_HEAD, fakeContext, failed, MY_SKILLS, ok, REMOTE_HEAD } from './helpers.mjs';

const GLOBAL = '/home/dev/.local/share/pnpm/global/v11/abc';
const APP = `${GLOBAL}/node_modules/.pnpm/rigup@0.2.0/node_modules/rigup`;
const SHA = 'a'.repeat(40);
const LOCK = `packages:\n\n  rigup@git+https://github.com/sychus/rigup.git#${SHA}:\n    resolution: {commit: ${SHA}, repo: https://github.com/sychus/rigup.git, type: git}\n    version: 0.2.0\n`;

const installed = (spec, extra = {}) => fakeContext({
  files: {
    [`${GLOBAL}/package.json`]: JSON.stringify({ dependencies: { rigup: spec } }),
    [`${GLOBAL}/pnpm-lock.yaml`]: LOCK,
    [`${APP}/package.json`]: JSON.stringify({ name: 'rigup', version: '0.2.0' }),
    ...(extra.files || {}),
  },
  overrides: extra.overrides || {},
});
const withApp = ctx => Object.assign(ctx, { appDir: APP });

test('isGitSpec and gitSpecTarget', () => {
  assert.equal(isGitSpec('^0.2.0'), false);
  assert.equal(isGitSpec('latest'), false);
  assert.equal(isGitSpec('github:sychus/rigup'), true);
  assert.equal(isGitSpec('sychus/rigup#dev'), true);
  assert.deepEqual(gitSpecTarget('github:sychus/rigup#dev'), { urls: ['git@github.com:sychus/rigup.git', 'https://github.com/sychus/rigup.git'], ref: 'dev' });
  assert.deepEqual(gitSpecTarget('git+https://gitlab.com/x/rigup.git'), { urls: ['https://gitlab.com/x/rigup.git'], ref: null });
});

test('lockCommit reads the commit pnpm resolved for rigup', () => {
  assert.equal(lockCommit(LOCK), SHA);
  assert.equal(lockCommit('packages:\n  other@1.0.0:\n    resolution: {commit: bbbb}'), null);
});

test('findInstall walks up to the global project; null from a checkout', () => {
  assert.deepEqual(findInstall(withApp(installed('github:sychus/rigup'))), { spec: 'github:sychus/rigup', commit: SHA });
  assert.equal(findInstall(fakeContext()), null);
});

test('updateSelf from npm: nothing when current, pnpm add -g rigup@latest when behind', () => {
  const current = withApp(installed('^0.2.0', { overrides: { 'npm view rigup version': ok('0.2.0\n') } }));
  assert.deepEqual(updateSelf(current), { status: 'ok', text: 'rigup 0.2.0 is the latest', changed: false });
  assert.ok(!current.calls.some(c => c.key.startsWith('pnpm')));
  const behind = withApp(installed('^0.2.0', { overrides: { 'npm view rigup version': ok('0.3.1\n'), 'pnpm add -g rigup@latest': ok('') } }));
  assert.deepEqual(updateSelf(behind), { status: 'ok', text: 'rigup 0.2.0 → 0.3.1', changed: true });
});

test('updateSelf from git: compares the installed commit with the branch head', () => {
  const same = withApp(installed('github:sychus/rigup', { overrides: { 'git ls-remote git@github.com:sychus/rigup.git HEAD': ok(`${SHA}\tHEAD\n`) } }));
  assert.equal(updateSelf(same).text, 'rigup is up to date (aaaaaaa)');
  const newer = withApp(installed('github:sychus/rigup', { overrides: {
    'git ls-remote git@github.com:sychus/rigup.git HEAD': ok(`${'b'.repeat(40)}\tHEAD\n`),
    'pnpm add -g github:sychus/rigup': ok(''),
  } }));
  assert.equal(updateSelf(newer).text, 'rigup aaaaaaa → bbbbbbb');
  const broken = withApp(installed('github:sychus/rigup', { overrides: { 'pnpm add -g github:sychus/rigup': failed() } }));
  assert.equal(updateSelf(broken).status, 'fail');
});

test('updateSelf from a checkout: skipped with a note', () => {
  assert.equal(updateSelf(fakeContext()).status, 'info');
});

test('runUpdate: refreshes sources, rebuilds rigup-local, updates plugins, shows what moved', () => {
  let head = CLONE_HEAD;
  const ctx = fakeContext({
    mtimes: { [MY_SKILLS]: Date.parse('2026-11-20T00:00:00Z') },
    overrides: {
      'claude plugin marketplace update acme-skills --json': ok('{}'),
      'claude plugin marketplace update rigup-local --json': ok('{}'),
      'claude plugin update review@acme-skills --json': ok(JSON.stringify({ updateOutcome: 'updated', oldVersion: 'a', newVersion: 'b' })),
      'claude plugin update release@acme-skills --json': ok(JSON.stringify({ updateOutcome: 'up_to_date', oldVersion: 'a', newVersion: 'a' })),
      'claude plugin update my-skills@rigup-local --json': ok(JSON.stringify({ updateOutcome: 'updated', oldVersion: 'unknown', newVersion: 'unknown' })),
    },
  });
  // The clone head moves when the marketplace is refreshed.
  const run = ctx.run.bind(ctx);
  ctx.run = (cmd, args, opts) => {
    const key = [cmd, ...args].join(' ');
    if (key === 'claude plugin marketplace update acme-skills --json') head = REMOTE_HEAD;
    if (key === `git -C ${ACME_LOCATION} rev-parse HEAD`) return ok(`${head}\n`);
    return run(cmd, args, opts);
  };
  const out = [];
  assert.equal(runUpdate(ctx, { log: l => out.push(l) }), 0);
  const text = out.join('\n');
  assert.match(text, /ℹ rigup is not a pnpm global install/);
  assert.match(text, /✔ acme\/claude-skills 1111111 → 2222222/);
  assert.match(text, /✔ rigup-local rebuilt from 1 local folder/);
  assert.match(text, /✔ updated: review, my-skills \(2 plugins\)/);
  assert.match(text, /What changed/);
  assert.match(text, /Restart open Claude sessions/);
  assert.ok(ctx.ops.some(o => o.startsWith('symlink')));
});

test('runUpdate: a local plugin whose folder did not change is not refreshed', () => {
  const ctx = fakeContext({
    overrides: {
      'claude plugin marketplace update acme-skills --json': ok('{}'),
      'claude plugin marketplace update rigup-local --json': ok('{}'),
      'claude plugin update review@acme-skills --json': ok(JSON.stringify({ updateOutcome: 'up_to_date' })),
      'claude plugin update release@acme-skills --json': ok(JSON.stringify({ updateOutcome: 'up_to_date' })),
    },
  });
  const out = [];
  assert.equal(runUpdate(ctx, { log: l => out.push(l) }), 0);
  assert.ok(!ctx.calls.some(c => c.key === 'claude plugin update my-skills@rigup-local --json'));
  assert.match(out.join('\n'), /plugins are up to date \(3\)/);
  assert.doesNotMatch(out.join('\n'), /Restart/);
});

test('runUpdate: a failed refresh or plugin update fails the run but the rest still runs', () => {
  const ctx = fakeContext({ overrides: {
    'claude plugin marketplace update acme-skills --json': failed('offline'),
    'claude plugin marketplace update rigup-local --json': ok('{}'),
    'claude plugin update review@acme-skills --json': failed(),
    'claude plugin update release@acme-skills --json': ok('{}'),
  } });
  const out = [];
  assert.equal(runUpdate(ctx, { log: l => out.push(l) }), 1);
  assert.match(out.join('\n'), /✖ could not refresh acme\/claude-skills/);
  assert.match(out.join('\n'), /✖ could not update review/);
});
