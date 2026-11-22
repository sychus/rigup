// Run: node --test test/*.test.mjs
//
// rigup changes: path mapping and classification on synthetic `git diff --name-status` output,
// then the git plumbing against a fake context.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChanges, componentOf, countChanges, formatChanges, parseNameStatus } from '../src/changes.mjs';
import { cacheDirFor, computeChanges, openHistory, resolveBound, rootsAt } from '../src/history.mjs';
import { changesForSources } from '../src/changes-command.mjs';
import { fakeContext, failed, ok } from './helpers.mjs';

const ROOTS = [{ prefix: 'plugins/review', plugin: 'review' }, { prefix: 'plugins/release', plugin: 'release' }];

test('componentOf: skills, agents and commands under each plugin; longest prefix wins', () => {
  assert.deepEqual(componentOf('plugins/review/skills/pr/SKILL.md', ROOTS), { plugin: 'review', kind: 'skill', name: 'pr', main: true, rel: 'plugins/review/skills/pr/SKILL.md' });
  assert.equal(componentOf('plugins/review/skills/pr/refs/a.md', ROOTS).main, false);
  assert.equal(componentOf('plugins/release/agents/shipper.md', ROOTS).kind, 'agent');
  assert.equal(componentOf('plugins/release/commands/ship.md', ROOTS).kind, 'command');
  assert.equal(componentOf('plugins/review/README.md', ROOTS), null);
  assert.equal(componentOf('docs/x.md', ROOTS), null);
  const nested = [{ prefix: '', plugin: 'root' }, { prefix: 'inner', plugin: 'inner' }];
  assert.equal(componentOf('inner/skills/a/SKILL.md', nested).plugin, 'inner');
  assert.equal(componentOf('skills/a/SKILL.md', nested).plugin, 'root');
});

test('componentOf: flat folders map <name>/SKILL.md, ignoring dot folders', () => {
  const flat = [{ prefix: 'team', plugin: 'team', flat: true }];
  assert.deepEqual(componentOf('team/greet/SKILL.md', flat), { plugin: 'team', kind: 'skill', name: 'greet', main: true, rel: 'team/greet/SKILL.md' });
  assert.equal(componentOf('team/.github/x.md', flat), null);
});

test('classifyChanges: new, updated, renamed and removed, one line per component', () => {
  const entries = parseNameStatus([
    'A\tplugins/review/skills/pr/SKILL.md',
    'A\tplugins/review/skills/pr/refs/a.md',
    'M\tplugins/review/skills/lint/refs/b.md',
    'R092\tplugins/release/commands/old.md\tplugins/release/commands/ship.md',
    'D\tplugins/release/agents/gone.md',
    'M\tREADME.md',
  ].join('\n'));
  const items = classifyChanges(entries, ROOTS);
  assert.deepEqual(items.map(i => `${i.plugin}:${i.status}:${i.name}`), [
    'release:renamed:ship', 'release:removed:gone', 'review:new:pr', 'review:updated:lint',
  ]);
  assert.equal(items[0].from, 'old');
  assert.deepEqual(countChanges(items), { total: 4, new: 1, updated: 1, renamed: 1, removed: 1 });
});

test('formatChanges: grouped by source and plugin; skipped sources say why', () => {
  const text = formatChanges([
    { source: 'acme/s', base: 'a'.repeat(40), head: 'b'.repeat(40), items: [{ plugin: 'review', kind: 'skill', name: 'pr', status: 'new', description: 'Reviews PRs' }] },
    { source: '~/notes', skipped: 'not in a git repo, so there is no history' },
    { source: 'acme/quiet', base: 'c'.repeat(40), head: 'c'.repeat(40), items: [] },
  ], { window: 'since 7d ago' });
  assert.match(text, /^rigup changes · since 7d ago\n1 item · 1 new/);
  assert.match(text, /acme\/s {2}aaaaaaa → bbbbbbb\n {2}review\n {4}new {6}pr {9}— Reviews PRs/);
  assert.match(text, /~\/notes {2}\(not in a git repo/);
  assert.doesNotMatch(text, /acme\/quiet/);
  assert.match(formatChanges([], { window: 'w' }), /No skill, agent or command changed/);
});

// A fake repo source with its bare cache already cloned.
const CACHE = '/home/dev/.cache/rigup/history/acme-claude-skills';
const HEAD = 'f'.repeat(40);
const BASE = 'e'.repeat(40);
const CATALOG = JSON.stringify({ plugins: [{ name: 'review', source: './plugins/review' }, { name: 'ext', source: { source: 'url', url: 'x' } }] });
const remote = { kind: 'remote', label: 'acme/claude-skills', spec: { type: 'github', id: 'acme/claude-skills', repo: 'acme/claude-skills', ref: null }, selection: '*' };
const gitCtx = (overrides = {}) => fakeContext({
  files: { [`${CACHE}/HEAD`]: 'ref: refs/heads/main' },
  overrides: {
    [`git -C ${CACHE} fetch -q --no-tags --filter=blob:none origin +refs/heads/*:refs/heads/*`]: ok(''),
    [`git -C ${CACHE} rev-parse --verify --quiet HEAD^{commit}`]: ok(`${HEAD}\n`),
    [`git -C ${CACHE} show ${HEAD}:.claude-plugin/marketplace.json`]: ok(CATALOG),
    [`git -C ${CACHE} show ${BASE}:.claude-plugin/marketplace.json`]: ok(CATALOG),
    [`git -C ${CACHE} rev-list -1 --before=7 days ago ${HEAD}`]: ok(`${BASE}\n`),
    [`git -C ${CACHE} diff --name-status -M ${BASE} ${HEAD} -- plugins/review`]: ok('A\tplugins/review/skills/pr/SKILL.md\nA\tplugins/review/skills/_shared/x.md\n'),
    [`git -C ${CACHE} show ${HEAD}:plugins/review/skills/pr/SKILL.md`]: ok('---\ndescription: Reviews PRs. Long.\n---\n'),
    ...overrides,
  },
});

test('openHistory: refreshes the cache it owns; clones it SSH first, then HTTPS', () => {
  const ctx = gitCtx();
  assert.equal(cacheDirFor(ctx, remote.spec), CACHE);
  assert.deepEqual(openHistory(ctx, remote), { dir: CACHE, head: HEAD, prefix: '' });
  const fresh = fakeContext({ overrides: {
    [`git clone -q --bare --filter=blob:none --no-tags git@github.com:acme/claude-skills.git ${CACHE}`]: failed(),
    [`git clone -q --bare --filter=blob:none --no-tags https://github.com/acme/claude-skills.git ${CACHE}`]: ok(''),
    [`git -C ${CACHE} rev-parse --verify --quiet HEAD^{commit}`]: ok(`${HEAD}\n`),
  } });
  assert.equal(openHistory(fresh, remote).head, HEAD);
  assert.throws(() => openHistory(fakeContext(), remote), /cannot clone it without a prompt/);
});

test('openHistory: local folders use their repo read-only, with the folder as prefix', () => {
  const local = { kind: 'plugin', spec: { type: 'local', path: '/home/dev/repo/skills-pack' }, pluginName: 'skills-pack' };
  const ctx = fakeContext({ overrides: {
    'git -C /home/dev/repo/skills-pack rev-parse --show-toplevel': ok('/home/dev/repo\n'),
    'git -C /home/dev/repo rev-parse HEAD': ok(`${HEAD}\n`),
    'git -C /home/dev/repo/skills-pack rev-parse --show-prefix': ok('skills-pack/\n'),
  } });
  assert.deepEqual(openHistory(ctx, local), { dir: '/home/dev/repo', head: HEAD, prefix: 'skills-pack' });
  assert.ok(!ctx.calls.some(c => /fetch|reset|checkout/.test(c.key)));
  assert.throws(() => openHistory(fakeContext(), local), /not in a git repo/);
  assert.deepEqual(rootsAt(ctx, local, { prefix: 'skills-pack' }, HEAD), [{ prefix: 'skills-pack', plugin: 'skills-pack' }]);
});

test('rootsAt: ./ plugins of the catalog at that commit; external ones have no folder', () => {
  assert.deepEqual(rootsAt(gitCtx(), remote, { dir: CACHE, prefix: '' }, HEAD), [{ prefix: 'plugins/review', plugin: 'review' }]);
  assert.deepEqual(rootsAt(gitCtx(), { ...remote, selection: ['ext'] }, { dir: CACHE, prefix: '' }, HEAD), []);
});

test('computeChanges reads descriptions and drops folders that are not skills', () => {
  const items = computeChanges(gitCtx(), remote, { dir: CACHE, prefix: '' }, BASE, HEAD);
  assert.deepEqual(items, [{ plugin: 'review', kind: 'skill', name: 'pr', status: 'new', description: 'Reviews PRs' }]);
});

test('resolveBound: days, dates (end of day for --until) and commits', () => {
  const ctx = fakeContext({ overrides: {
    [`git -C /r rev-list -1 --before=14 days ago H`]: ok('a\n'),
    [`git -C /r rev-list -1 --before=2026-11-13 00:00 H`]: ok('b\n'),
    [`git -C /r rev-parse --verify --quiet v1^{commit}`]: ok('c\n'),
  } });
  assert.equal(resolveBound(ctx, '/r', 'H', '2w'), 'a');
  assert.equal(resolveBound(ctx, '/r', 'H', '2026-11-12', { endOfDay: true }), 'b');
  assert.equal(resolveBound(ctx, '/r', 'H', 'v1'), 'c');
  assert.equal(resolveBound(ctx, '/r', 'H', 'nope'), null);
});

test('changesForSources: one result per source, failures become skipped lines', () => {
  const results = changesForSources(gitCtx(), { sources: [remote, { kind: 'missing', label: '/gone', spec: {} }] });
  assert.equal(results[0].items.length, 1);
  assert.deepEqual(results[1], { source: '/gone', skipped: 'folder not found' });
});
