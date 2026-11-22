// Run: node --test test/*.test.mjs
//
// rigup doctor against the fake machine in helpers.mjs, then one rule at a time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherFacts } from '../src/facts.mjs';
import { checkConfig, checkRequirements, checkSource, checkUpdateEnv, LARGE_CATALOG } from '../src/checks.mjs';
import { doctor, exitCode, formatReport, summaryHint } from '../src/doctor.mjs';
import { ACME_LOCATION, CONFIG_FILE, fakeContext, failed, HOME, MY_SKILLS, ok } from './helpers.mjs';

const titles = report => report.sections.flatMap(s => s.results.map(r => `${r.status} ${r.title}`));
const section = (report, start) => report.sections.find(s => s.title.startsWith(start));

test('gatherFacts: one entry per source, with what is wanted and installed', () => {
  const facts = gatherFacts(fakeContext());
  const [acme, mine] = facts.sources;
  assert.equal(acme.kind, 'remote');
  assert.equal(acme.marketplaceName, 'acme-skills');
  assert.deepEqual(acme.wanted, ['docs', 'release', 'review']);
  assert.deepEqual(acme.installed.map(p => p.id), ['review@acme-skills', 'release@acme-skills']);
  assert.equal(mine.kind, 'plugin');
  assert.equal(mine.pluginName, 'my-skills');
  assert.equal(mine.inLocalMarketplace, true);
  assert.deepEqual(mine.installed.map(p => p.id), ['my-skills@rigup-local']);
});

test('doctor on the fake machine: missing plugin and stale clone; setup fixes, exit 1', () => {
  const report = doctor(fakeContext());
  const all = titles(report);
  assert.ok(all.includes('fail not installed: docs'));
  assert.ok(all.includes(`warn behind the remote (1111111 → 2222222)`));
  assert.ok(all.includes('ok linked as plugin "my-skills" in rigup-local'));
  assert.equal(report.next, 'setup');
  assert.equal(exitCode(report), 1);
  const text = formatReport(report);
  assert.match(text, /^rigup doctor/);
  assert.match(text, /Source acme\/claude-skills {2}\(marketplace repo\)/);
  assert.match(text, /Source ~\/work\/my-skills {2}\(local plugin folder\)/);
  assert.match(text, /run `rigup setup` to fix what it can$/);
});

test('doctor with no config tells you to add a source, and nothing else about sources', () => {
  const report = doctor(fakeContext({ files: { [CONFIG_FILE]: null } }));
  assert.deepEqual(section(report, 'Config').results, [{ status: 'fail', title: 'no config yet', fix: 'rigup add <owner/repo | git URL | folder>' }]);
  assert.equal(section(report, 'Requirements'), undefined);
  assert.equal(summaryHint(report), 'fix the ✖ items above');
});

test('remote source: no access without a prompt; setup can fix it only when gh is signed in', () => {
  const noAccess = { 'git ls-remote git@github.com:acme/claude-skills.git HEAD': failed(), 'git ls-remote https://github.com/acme/claude-skills.git HEAD': failed() };
  const signedIn = doctor(fakeContext({ overrides: noAccess }));
  const access = section(signedIn, 'Source acme').results.find(r => r.title.startsWith('no git access'));
  assert.equal(access.by, 'setup');
  const signedOut = doctor(fakeContext({ overrides: { ...noAccess, 'gh auth status': failed() } }));
  const fix = section(signedOut, 'Source acme').results.find(r => r.title.startsWith('no git access'));
  assert.equal(fix.by, undefined);
  assert.equal(fix.fix, 'gh auth login && gh auth setup-git');
});

test('remote source not registered: one line, fixed by setup', () => {
  const report = doctor(fakeContext({ overrides: { 'claude plugin marketplace list --json': ok('[]') } }));
  const results = section(report, 'Source acme').results;
  assert.deepEqual(results.map(r => r.title), ['reachable without a prompt (git@github.com:acme/claude-skills.git)', 'not registered in Claude Code']);
});

test('auto-update off is a warning setup fixes', () => {
  const report = doctor(fakeContext({ files: { [`${HOME}/.claude/settings.json`]: '{}' } }));
  const r = section(report, 'Source acme').results.find(x => x.title.startsWith('auto-update'));
  assert.equal(r.status, 'warn');
  assert.equal(r.by, 'setup');
});

test('local folder edited after the installed copy: rigup update refreshes it', () => {
  const report = doctor(fakeContext({ mtimes: { [MY_SKILLS]: Date.parse('2026-11-20T00:00:00Z') } }));
  const r = section(report, 'Source ~/work/my-skills').results.find(x => x.title.startsWith('edited since'));
  assert.equal(r.by, 'update');
});

test('only update-fixable problems: doctor suggests rigup update', () => {
  const ctx = fakeContext({
    config: { sources: [{ source: 'acme/claude-skills', plugins: ['review'] }] },
  });
  const report = doctor(ctx);
  assert.equal(report.next, 'update');
  assert.equal(summaryHint(report), 'run `rigup update`');
});

test('local folder not linked yet, missing, or empty', () => {
  const unlinked = doctor(fakeContext({ files: { [`${HOME}/.local/share/rigup/marketplace/.claude-plugin/marketplace.json`]: JSON.stringify({ plugins: [] }) } }));
  assert.ok(titles(unlinked).includes('fail not linked into the rigup-local marketplace'));
  const missing = doctor(fakeContext({ config: { sources: ['/nowhere'] } }));
  assert.ok(titles(missing).includes('fail /nowhere does not exist'));
  const empty = doctor(fakeContext({ config: { sources: ['~/empty'] }, files: { [`${HOME}/empty/README.md`]: 'hi' } }));
  assert.ok(titles(empty).some(t => t.startsWith('fail no skills, agents, commands')));
});

test('flat folder of <name>/SKILL.md is recognized and named after the folder', () => {
  const facts = gatherFacts(fakeContext({
    config: { sources: ['~/Team Skills'] },
    files: { [`${HOME}/Team Skills/greet/SKILL.md`]: '---\nname: greet\n---\n' },
  }));
  assert.equal(facts.sources[0].kind, 'flat');
  assert.equal(facts.sources[0].pluginName, 'team-skills');
});

test('checkConfig: two local folders with the same name collide', () => {
  const facts = { config: { errors: [], sources: [1, 2], exists: true }, sources: [{ pluginName: 'skills', label: '~/a/skills' }, { pluginName: 'skills', label: '~/b/skills' }] };
  const results = checkConfig(facts, 'cfg');
  assert.match(results[1].title, /~\/a\/skills and ~\/b\/skills would both be plugin "skills"/);
});

test('checkSource: unknown names in "plugins", disabled plugins, and a hint for huge catalogs', () => {
  const base = {
    label: 'acme/x', kind: 'remote', spec: { type: 'github' }, access: { ok: true, url: 'u', head: 'h' }, cloneHead: 'h',
    marketplace: { name: 'x' }, marketplaceName: 'x', catalog: {}, pluginName: null,
  };
  const facts = { gh: { authenticated: true }, userSettings: { extraKnownMarketplaces: { x: { autoUpdate: true } } } };
  const picked = checkSource({ ...base, selection: ['a', 'zz'], available: ['a', 'b'], wanted: ['a', 'zz'], installed: [{ id: 'a@x', enabled: false }] }, facts);
  const t = picked.results.map(r => r.title);
  assert.ok(t.includes("not in this source's catalog: zz"));
  assert.ok(t.includes('a: installed but disabled'));
  const many = Array.from({ length: LARGE_CATALOG + 1 }, (_, i) => `p${i}`);
  const huge = checkSource({ ...base, selection: '*', available: many, wanted: many, installed: many.map(n => ({ id: `${n}@x` })) }, facts);
  assert.ok(huge.results.some(r => r.status === 'info' && /taking all 26 plugins/.test(r.title)));
});

test('checkUpdateEnv: a disabling variable warns unless updates are forced on', () => {
  assert.deepEqual(checkUpdateEnv({ userSettings: {} }, {}), []);
  assert.equal(checkUpdateEnv({ userSettings: {} }, { DISABLE_AUTOUPDATER: '1' })[0].by, 'setup');
  assert.equal(checkUpdateEnv({ userSettings: { env: { FORCE_AUTOUPDATE_PLUGINS: '1' } } }, { DISABLE_AUTOUPDATER: '1' })[0].status, 'ok');
});

test('requirements: required missing fails, optional missing is info, gaps are grouped', () => {
  const results = checkRequirements([
    { plugin: 'a', tools: [{ name: 'jq', present: false }], env: [{ name: 'TOKEN', optional: true, usedBy: ['s1'], present: false }], connectors: [] },
    { plugin: 'b', tools: [{ name: 'jq', present: false }], env: [], connectors: [{ name: 'Docs', found: 'Docs MCP', output: 'Status: ✔ Connected' }] },
  ]);
  const t = results.map(r => `${r.status} ${r.title}`);
  assert.ok(t.includes('fail a, b: needs jq'));
  assert.ok(t.includes('info a: TOKEN not set (used by s1)'));
  assert.ok(t.some(x => x.startsWith('warn b: "Docs" found as "Docs MCP"')));
});

test('requirements are read from installed copies, and from the folder for local plugins', () => {
  const ctx = fakeContext({
    files: {
      [`${MY_SKILLS}/requirements.json`]: JSON.stringify({ tools: [{ name: 'jq' }] }),
      [`${HOME}/.claude/plugins/cache/acme-skills/review/abc123def456/requirements.json`]: JSON.stringify({ env: [{ name: 'REVIEW_TOKEN' }] }),
    },
    overrides: { "sh -c command -v 'jq'": ok('/usr/bin/jq') },
  });
  const t = titles(doctor(ctx));
  assert.ok(t.includes('fail review: REVIEW_TOKEN is not set'));
  assert.ok(!t.some(x => x.includes('needs jq')));
  assert.ok(ACME_LOCATION);
});
