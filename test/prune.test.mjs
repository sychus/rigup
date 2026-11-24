// Run: node --test test/*.test.mjs
//
// rigup prune and the config's "exclude": use read from transcript lines in the shapes Claude
// Code writes them, on the fake machine (acme-skills: review and release installed; my-skills
// linked from a local folder).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrune, parseDays, planPrune, pruneReport, scanUsage } from '../src/prune.mjs';
import { readUsage, runPrune } from '../src/prune-command.mjs';
import { excludePlugins, loadConfig, normalizeConfig } from '../src/config.mjs';
import { gatherFacts } from '../src/facts.mjs';
import { planSetup } from '../src/setup.mjs';
import { CONFIG_FILE, fakeContext, HOME } from './helpers.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const PROJECTS = `${HOME}/.claude/projects`;

const SKILL_LINE = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"review:pr-review"}}]}}';
const AGENT_LINE = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent","input":{"subagent_type":"release:shipper","prompt":"x"}}]}}';
const COMMAND_LINE = '{"type":"user","message":{"role":"user","content":"<command-message>my-skills:hello</command-message>\\n<command-name>/my-skills:hello</command-name>"}}';
// Quoted by a tool or a file: not use.
const QUOTED = [
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"{\\"skill\\":\\"release:ship\\"}"}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"   6 <command-name>/release:ship</command-name>"}]}}',
].join('\n');
const NAMES = new Set(['review', 'release', 'my-skills']);

test('scanUsage: skills, agents and typed commands of known plugins; quoted text does not count', () => {
  const uses = scanUsage([SKILL_LINE, SKILL_LINE, AGENT_LINE, COMMAND_LINE, QUOTED, '{"name":"Skill","input":{"skill":"other:x"}}'].join('\n'), NAMES);
  assert.deepEqual(Object.fromEntries(uses), { review: 2, release: 1, 'my-skills': 1 });
  assert.equal(scanUsage(null, NAMES).size, 0);
});

test('parseDays: default 28, whole numbers only', () => {
  assert.equal(parseDays([]), 28);
  assert.equal(parseDays(['--days', '60']), 60);
  assert.equal(parseDays(['--days', '0']), null);
  assert.equal(parseDays(['--days']), null);
});

const PLUGINS = [
  { id: 'review@acme-skills', name: 'review', source: 'acme/claude-skills', sourceId: 'acme/claude-skills', kind: 'remote', scope: 'user', installedAt: '2026-09-01T00:00:00Z' },
  { id: 'release@acme-skills', name: 'release', source: 'acme/claude-skills', sourceId: 'acme/claude-skills', kind: 'remote', scope: 'user', installedAt: '2026-09-01T00:00:00Z' },
  { id: 'docs@acme-skills', name: 'docs', source: 'acme/claude-skills', sourceId: 'acme/claude-skills', kind: 'remote', scope: 'user', installedAt: new Date(NOW - 2 * DAY).toISOString() },
  { id: 'my-skills@rigup-local', name: 'my-skills', source: '~/work/my-skills', sourceId: `${HOME}/work/my-skills`, kind: 'plugin', scope: 'user', installedAt: '2026-09-01T00:00:00Z' },
];
const report = (extra = {}) => pruneReport({
  plugins: PLUGINS,
  usage: new Map([['review', { uses: 3, lastSeen: NOW - DAY }]]),
  tokens: { 'release@acme-skills': 120, 'my-skills@rigup-local': 30 },
  oldest: NOW - 40 * DAY,
  now: NOW,
  days: 28,
  ...extra,
});

test('pruneReport: unused = no use, enough history, not installed inside the window', () => {
  const r = report();
  assert.deepEqual(r.unused.map(x => x.id), ['release@acme-skills', 'my-skills@rigup-local']);
  assert.equal(r.rows.find(x => x.name === 'docs').recent, true);
  assert.deepEqual(report({ oldest: NOW - 10 * DAY }).unused, []);
  assert.match(formatPrune(report({ oldest: null })), /Not enough history yet/);
});

test('planPrune: marketplace plugins are pruned; local folders and installs that are not rigup\'s only get the command', () => {
  const unused = [...report().unused, { ...PLUGINS[1], id: 'x@acme-skills', name: 'x', scope: 'managed' }];
  const actions = planPrune(unused);
  assert.deepEqual(actions.map(a => a.kind), ['prune', 'hint', 'hint']);
  assert.match(actions[1].fix, /rigup remove ~\/work\/my-skills && claude plugin uninstall my-skills@rigup-local --scope user/);
  assert.equal(actions[2].fix, 'claude plugin disable x@acme-skills');
});

test('formatPrune: grouped by source, with what each costs and what removing saves', () => {
  const text = formatPrune(report());
  assert.match(text, /acme\/claude-skills\n {2}review {4,}3 uses, last 2026-11-23/);
  assert.match(text, /release {3,}no use · ~120 tokens per prompt {2}· unused/);
  assert.match(text, /docs[^\n]*installed recently, too soon to tell/);
  assert.match(text, /saves ~150 tokens on every prompt/);
  const used = new Map(['review', 'release', 'my-skills'].map(n => [n, { uses: 1, lastSeen: NOW }]));
  assert.match(formatPrune(report({ usage: used })), /Nothing to prune: every plugin was used or is too new to tell\./);
});

test('excludePlugins: "*" sources get an exclude list; explicit lists drop the name', () => {
  const raw = { sources: [{ source: 'acme/claude-skills' }, { source: 'acme/other', plugins: ['a', 'b'] }] };
  const out = excludePlugins(excludePlugins(raw, 'acme/claude-skills', ['release'], {}), 'acme/other', ['a'], {});
  assert.deepEqual(out.sources, [{ source: 'acme/claude-skills', exclude: ['release'] }, { source: 'acme/other', plugins: ['b'] }]);
  assert.deepEqual(normalizeConfig({ sources: [{ source: 'a/b', exclude: 'x' }] }).errors, ['sources[0]: "exclude" must be a list of plugin names']);
});

test('an excluded plugin is not wanted: setup does not reinstall it and doctor does not ask for it', () => {
  const config = { sources: [{ source: 'acme/claude-skills', exclude: ['docs'] }] };
  const facts = gatherFacts(fakeContext({ config }));
  assert.deepEqual(facts.sources[0].wanted, ['release', 'review']);
  // docs is the plugin the fake machine is missing: excluded, nothing is left to install.
  assert.ok(!planSetup(facts, {}).some(a => a.kind === 'install'));
});

// The fake machine installed its plugins on 2026-11-01; a month and a half later they are old
// enough to judge.
const LATER = Date.parse('2026-12-20T12:00:00Z');

/** The fake machine with transcripts on disk and a fixed clock. */
function pruneMachine(transcripts) {
  const files = {};
  for (const t of transcripts) files[t.path] = t.text;
  const ctx = fakeContext({ files });
  ctx.now = () => new Date(LATER);
  ctx.listFiles = (dir, ext) => (dir === PROJECTS ? transcripts.filter(t => t.path.endsWith(ext)).map(({ path, mtimeMs }) => ({ path, mtimeMs })) : []);
  return ctx;
}
const TRANSCRIPTS = [
  { path: `${PROJECTS}/-a/1.jsonl`, mtimeMs: LATER - DAY, text: `${SKILL_LINE}\n${COMMAND_LINE}` },
  { path: `${PROJECTS}/-b/old.jsonl`, mtimeMs: LATER - 60 * DAY, text: AGENT_LINE },
];

test('readUsage: only transcripts inside the window', () => {
  const { usage, oldest } = readUsage(pruneMachine(TRANSCRIPTS), 28, NAMES);
  assert.equal(oldest, LATER - 60 * DAY);
  assert.deepEqual(usage.get('review'), { uses: 1, lastSeen: LATER - DAY });
  assert.equal(usage.get('release'), undefined);
});

test('rigup prune: reports and changes nothing; --yes uninstalls and leaves it out of the config', () => {
  const out = [];
  const io = { log: l => out.push(l), error: l => out.push(l) };
  const ctx = pruneMachine(TRANSCRIPTS);
  assert.equal(runPrune(ctx, [], io), 0);
  assert.match(out.join('\n'), /release {3,}no use/);
  assert.ok(!ctx.calls.some(c => /plugin uninstall/.test(c.key)));
  assert.deepEqual(ctx.writes, []);

  const yes = pruneMachine(TRANSCRIPTS);
  yes.run = ((run) => (cmd, args, opts) => (args[1] === 'uninstall' ? (yes.calls.push({ key: [cmd, ...args].join(' ') }), { status: 0, stdout: '{}', stderr: '' }) : run(cmd, args, opts)))(yes.run.bind(yes));
  assert.equal(runPrune(yes, ['--yes'], io), 0);
  assert.ok(yes.calls.some(c => c.key === 'claude plugin uninstall release@acme-skills --scope user --json'));
  assert.ok(!yes.calls.some(c => /uninstall review/.test(c.key)));
  assert.deepEqual(loadConfig(yes).sources.find(s => s.spec.id === 'acme/claude-skills').exclude, ['release']);
  assert.ok(yes.writes.some(w => w.file === CONFIG_FILE));
});
