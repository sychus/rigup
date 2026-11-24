// Run: node --test test/*.test.mjs
//
// rigup setup: every decision in planSetup, then applySetup against the fake machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherFacts } from '../src/facts.mjs';
import { applySetup, mergeSettings, planSetup } from '../src/setup.mjs';
import { buildLocalCatalog, writeLocalMarketplace } from '../src/local-marketplace.mjs';
import { runSetup } from '../src/setup-command.mjs';
import {
  CONFIG_FILE, fakeContext, failed, HOME, LOCAL_MP_DIR, MARKETPLACES, MY_SKILLS, ok, PLUGINS,
} from './helpers.mjs';

const kinds = plan => plan.map(a => a.kind);
const plan = (opts = {}, env = {}) => planSetup(gatherFacts(fakeContext(opts)), env);
const noAccess = {
  'git ls-remote git@github.com:acme/claude-skills.git HEAD': failed(),
  'git ls-remote https://github.com/acme/claude-skills.git HEAD': failed(),
};
const installed = [...PLUGINS, { id: 'docs@acme-skills', enabled: true, scope: 'user' }];
const SETTINGS = `${HOME}/.claude/settings.json`;

test('fake machine: only the missing plugin to install', () => {
  assert.deepEqual(kinds(plan()), ['install']);
});

test('everything in place: empty plan, setup says nothing to do and runs nothing', () => {
  const ctx = fakeContext({ overrides: { 'claude plugin list --json': ok(JSON.stringify(installed)) } });
  assert.deepEqual(planSetup(gatherFacts(ctx), {}), []);
  const out = [];
  assert.equal(runSetup(ctx, { log: l => out.push(l) }), 0);
  assert.match(out.join('\n'), /Nothing to do/);
  assert.ok(!ctx.calls.some(c => /install|marketplace add/.test(c.key)));
});

test('stops before anything: old claude, no sources, config errors, name clash', () => {
  assert.equal(plan({ overrides: { 'claude --version': ok('2.1.100 (Claude Code)') } })[0].kind, 'stop');
  assert.deepEqual(plan({ files: { [CONFIG_FILE]: null } }), [{ kind: 'stop', title: 'no sources yet', fix: 'rigup add <owner/repo | git URL | folder>' }]);
  assert.match(plan({ files: { [CONFIG_FILE]: '{"sources":[{"x":1}]}' } })[0].title, /config has errors/);
  const clash = plan({
    config: { sources: ['~/a/skills', '~/b/skills'] },
    files: { [`${HOME}/a/skills/s1/SKILL.md`]: 'x', [`${HOME}/b/skills/s2/SKILL.md`]: 'x' },
  });
  assert.match(clash[0].title, /both be plugin "skills"/);
});

test('unregistered remote: register it, turn on auto-update, then install', () => {
  const p = plan({ overrides: { 'claude plugin marketplace list --json': ok(JSON.stringify([MARKETPLACES[1]])) } });
  assert.deepEqual(kinds(p), ['run', 'settings', 'install']);
  assert.deepEqual(p[0].args, ['plugin', 'marketplace', 'add', 'acme/claude-skills', '--scope', 'user', '--json']);
  assert.deepEqual(p[1].sources, ['acme/claude-skills']);
});

test('no git access: gh setup-git when gh is signed in; otherwise skip that source only', () => {
  assert.deepEqual(plan({ overrides: noAccess })[0].args, ['auth', 'setup-git']);
  const skipped = plan({ overrides: { ...noAccess, 'gh auth status': failed() } });
  assert.equal(skipped[0].kind, 'hint');
  assert.match(skipped[0].title, /skipped acme\/claude-skills: no git access/);
  // The local folder is still set up: its plugin is installed, so nothing else to do here.
  assert.deepEqual(kinds(skipped), ['hint']);
});

test('missing folder is skipped with a hint; the rest still gets set up', () => {
  const p = plan({ config: { sources: ['acme/claude-skills', '/nowhere'] } });
  assert.deepEqual(kinds(p), ['hint', 'install']);
  assert.match(p[0].title, /skipped \/nowhere: folder not found/);
});

test('local folder not linked yet: refresh rigup-local, then install', () => {
  const p = plan({ files: { [`${LOCAL_MP_DIR}/.claude-plugin/marketplace.json`]: JSON.stringify({ plugins: [] }) } });
  assert.deepEqual(kinds(p), ['local-marketplace', 'install']);
  assert.equal(p[0].register, false);
  assert.equal(p[0].dir, LOCAL_MP_DIR);
});

test('rigup-local registered from another folder: skip local folders with the fix', () => {
  const elsewhere = [MARKETPLACES[0], { ...MARKETPLACES[1], path: '/tmp/old', installLocation: '/tmp/old' }];
  const p = plan({ overrides: { 'claude plugin marketplace list --json': ok(JSON.stringify(elsewhere)) } });
  assert.ok(p.some(a => a.kind === 'hint' && /registered from \/tmp\/old/.test(a.title)));
  assert.ok(!p.some(a => a.kind === 'local-marketplace'));
});

test('FORCE_AUTOUPDATE_PLUGINS only when this shell switches plugin updates off', () => {
  assert.ok(!plan({}, {}).some(a => a.kind === 'settings'));
  const p = plan({}, { DISABLE_AUTOUPDATER: '1' }).find(a => a.kind === 'settings');
  assert.equal(p.force, true);
  assert.deepEqual(p.sources, []);
});

test('apply: installs what is missing, at user scope', () => {
  const ctx = fakeContext({ overrides: { 'claude plugin install docs@acme-skills --scope user --json': ok('{"outcome":"ok"}') } });
  const { steps, changed } = applySetup(ctx, planSetup(gatherFacts(ctx), {}), { facts: gatherFacts(ctx) });
  assert.deepEqual(steps, [{ title: 'install docs@acme-skills', status: 'done' }]);
  assert.equal(changed, true);
});

test('apply: a failed step stops setup with its error', () => {
  const ctx = fakeContext({ overrides: { 'claude plugin install docs@acme-skills --scope user --json': failed('boom\nnetwork down') } });
  const { steps } = applySetup(ctx, [{ kind: 'install', title: 'x' }], { facts: gatherFacts(ctx) });
  assert.deepEqual(steps, [{ title: 'install docs@acme-skills', status: 'failed', detail: 'network down' }]);
});

test('apply settings: merges autoUpdate next to what Claude Code wrote; never overwrites invalid JSON', () => {
  const settings = JSON.stringify({ theme: 'dark', extraKnownMarketplaces: { 'acme-skills': { source: { source: 'github', repo: 'acme/claude-skills' } } } });
  const ctx = fakeContext({ files: { [SETTINGS]: settings } });
  applySetup(ctx, [{ kind: 'settings', title: 't', sources: ['acme/claude-skills'], force: true }], { facts: gatherFacts(ctx) });
  assert.deepEqual(JSON.parse(ctx.writes.at(-1).content), {
    theme: 'dark',
    extraKnownMarketplaces: { 'acme-skills': { source: { source: 'github', repo: 'acme/claude-skills' }, autoUpdate: true } },
    env: { FORCE_AUTOUPDATE_PLUGINS: '1' },
  });
  const bad = fakeContext({ files: { [SETTINGS]: '{nope' } });
  const { steps } = applySetup(bad, [{ kind: 'settings', title: 't', sources: ['acme/claude-skills'], force: false }], { facts: gatherFacts(bad) });
  assert.equal(steps[0].status, 'failed');
  assert.equal(bad.writes.length, 0);
});

test('apply local-marketplace: symlink for a plugin folder, copies for a flat one, then register', () => {
  const ctx = fakeContext({
    config: { sources: [MY_SKILLS, '~/flat'] },
    files: { [`${HOME}/flat/greet/SKILL.md`]: 'x', [`${HOME}/flat/README.md`]: 'x' },
    overrides: { [`claude plugin marketplace add ${LOCAL_MP_DIR} --scope user --json`]: ok('{}') },
  });
  const { steps } = applySetup(ctx, [{ kind: 'local-marketplace', title: 'create', dir: LOCAL_MP_DIR, register: true }], { facts: gatherFacts(ctx) });
  assert.equal(steps[0].status, 'done');
  assert.deepEqual(ctx.ops, [
    `remove ${LOCAL_MP_DIR}/plugins`,
    `mkdir ${LOCAL_MP_DIR}/plugins`,
    `symlink ${LOCAL_MP_DIR}/plugins/my-skills -> ${MY_SKILLS}`,
    `copy ${HOME}/flat/greet -> ${LOCAL_MP_DIR}/plugins/flat/skills/greet`,
  ]);
  const catalog = JSON.parse(ctx.writes.find(w => w.file.endsWith('marketplace.json')).content);
  assert.deepEqual(catalog.plugins.map(p => [p.name, p.source]), [['my-skills', './plugins/my-skills'], ['flat', './plugins/flat']]);
});

test('buildLocalCatalog uses ./ sources, the only kind Claude Code accepts', () => {
  const c = buildLocalCatalog([{ name: 'a', path: '/x/a', kind: 'plugin' }]);
  assert.equal(c.name, 'rigup-local');
  assert.equal(c.plugins[0].source, './plugins/a');
  assert.ok(writeLocalMarketplace);
});

test('dry run: shows the plan and runs nothing that changes the machine', () => {
  const ctx = fakeContext({ overrides: { 'claude plugin marketplace list --json': ok(JSON.stringify([MARKETPLACES[1]])) } });
  const out = [];
  assert.equal(runSetup(ctx, { dryRun: true, log: l => out.push(l) }), 0);
  assert.match(out.join('\n'), /→ register acme\/claude-skills as a marketplace/);
  assert.match(out.join('\n'), /Dry run: nothing was changed/);
  assert.ok(!ctx.calls.some(c => /plugin install|marketplace add/.test(c.key)));
  assert.equal(ctx.writes.length, 0);
});

test('mergeSettings keeps unrelated keys and nested objects', () => {
  assert.deepEqual(mergeSettings({ a: 1, n: { x: 1 } }, { n: { y: 2 } }), { a: 1, n: { x: 1, y: 2 } });
});

test('an auto-update entry without its source (rigup <= 0.2) is repaired: Claude Code ignores it', () => {
  const old = JSON.stringify({ extraKnownMarketplaces: { 'acme-skills': { autoUpdate: true } } });
  const p = plan({ files: { [SETTINGS]: old } }).find(a => a.kind === 'settings');
  assert.ok(p, 'setup plans the repair');
  const ctx = fakeContext({ files: { [SETTINGS]: old } });
  applySetup(ctx, [p], { facts: gatherFacts(ctx) });
  const written = JSON.parse(ctx.writes.find(w => w.file === SETTINGS).content);
  assert.deepEqual(written.extraKnownMarketplaces['acme-skills'], { autoUpdate: true, source: { source: 'github', repo: 'acme/claude-skills' } });
});

test('marketplaceSource: github and git keep their ref; local folders have none', async () => {
  const { marketplaceSource, parseSpec } = await import('../src/sources.mjs');
  assert.deepEqual(marketplaceSource(parseSpec('acme/skills@dev')), { source: 'github', repo: 'acme/skills', ref: 'dev' });
  assert.deepEqual(marketplaceSource(parseSpec('https://gitlab.com/a/b.git#main')), { source: 'git', url: 'https://gitlab.com/a/b.git', ref: 'main' });
  assert.deepEqual(marketplaceSource(parseSpec('git@gitlab.com:a/b.git')), { source: 'git', url: 'git@gitlab.com:a/b.git' });
  assert.equal(marketplaceSource(parseSpec('/tmp/x')), null);
});

test('setup saves a copy of settings.json before changing it, and says where', () => {
  const before = JSON.stringify({ theme: 'dark' });
  const ctx = fakeContext({ files: { [SETTINGS]: before } });
  ctx.now = () => new Date('2026-11-24T15:09:45.123Z');
  const { steps } = applySetup(ctx, [{ kind: 'settings', title: 't', sources: ['acme/claude-skills'], force: false }], { facts: gatherFacts(ctx) });
  const backup = `${SETTINGS}.rigup-backup-2026-11-24T15-09-45`;
  assert.deepEqual(ctx.writes.map(w => w.file), [backup, SETTINGS]);
  assert.equal(ctx.writes[0].content, before);
  assert.match(steps[0].detail, /previous settings saved to .*rigup-backup-2026-11-24T15-09-45/);
});
