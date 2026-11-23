// Run: node --test test/*.test.mjs
//
// rigup list / rigup search over the fake machine plus a few plugin files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatList, formatSearch, searchCatalog, usage } from '../src/catalog.mjs';
import { loadCatalog, pluginFolder, runList, runSearch, scanPlugin } from '../src/catalog-command.mjs';
import { frontmatterDescription, shortDescription } from '../src/frontmatter.mjs';
import { ACME_CATALOG, ACME_LOCATION, fakeContext, HOME, MY_SKILLS, ok } from './helpers.mjs';

const FILES = {
  [`${ACME_LOCATION}/plugins/review/skills/pr-review/SKILL.md`]: '---\nname: pr-review\ndescription: Reviews a pull request. Covers style and tests.\n---\nRead the pull request diff. Check the pull request tests.',
  [`${ACME_LOCATION}/plugins/review/skills/pr-review/references/extra.md`]: 'not a main file',
  [`${ACME_LOCATION}/plugins/review/agents/reviewer.md`]: '---\nname: reviewer\ndescription: Read-only reviewer agent.\n---\nreviews code',
  [`${ACME_LOCATION}/plugins/release/commands/ship.md`]: '---\ndescription: >\n  Ships a release\n  to production.\n---\nrelease notes, pull request list',
  [`${ACME_LOCATION}/plugins/docs/skills/write-docs/SKILL.md`]: '---\ndescription: "Writes docs."\n---\ndocs',
  [`${ACME_LOCATION}/plugins/docs/skills/_shared/notes.md`]: 'no SKILL.md here',
};
const ctx = (opts = {}) => fakeContext({ ...opts, files: { ...FILES, ...(opts.files || {}) } });
const names = entries => entries.map(e => `${e.plugin}/${e.kind}/${e.name}`);

test('frontmatter: quoted, folded and missing descriptions', () => {
  assert.equal(frontmatterDescription('---\ndescription: "Hi."\n---'), 'Hi.');
  assert.equal(frontmatterDescription('---\ndescription: >\n  a\n  b\n---'), 'a b');
  // The folded block stops at the next key; other keys' list items are not part of it.
  assert.equal(frontmatterDescription('---\ndescription: >\n  Does a thing\nallowed-tools:\n  - Bash\n---'), 'Does a thing');
  assert.equal(frontmatterDescription('no frontmatter'), null);
  assert.equal(shortDescription('One. Two.'), 'One');
});

test('loadCatalog: main files only, from repo marketplaces and local folders, sorted', () => {
  const { entries, notes } = loadCatalog(ctx());
  assert.deepEqual(names(entries), [
    'my-skills/skill/hello',
    'docs/skill/write-docs',
    'release/command/ship',
    'review/skill/pr-review',
    'review/agent/reviewer',
  ]);
  assert.deepEqual(notes, []);
  assert.equal(entries.find(e => e.name === 'ship').short, 'Ships a release to production');
  assert.equal(entries.find(e => e.name === 'hello').source, '~/work/my-skills');
});

test('loadCatalog: only the wanted plugins of a source', () => {
  const { entries } = loadCatalog(ctx({ config: { sources: [{ source: 'acme/claude-skills', plugins: ['release'] }] } }));
  assert.deepEqual(names(entries), ['release/command/ship']);
});

test('loadCatalog: flat folders, external plugins and unregistered repos', () => {
  const external = { ...ACME_CATALOG, plugins: [...ACME_CATALOG.plugins, { name: 'far', source: { source: 'url', url: 'https://x/y.git' } }] };
  const { entries, notes } = loadCatalog(ctx({
    config: { sources: ['acme/claude-skills', '~/flat', 'acme/unregistered'] },
    files: {
      [`${ACME_LOCATION}/.claude-plugin/marketplace.json`]: JSON.stringify(external),
      [`${HOME}/flat/greet/SKILL.md`]: '---\ndescription: Greets.\n---\n',
      [`${HOME}/flat/README.md`]: 'x',
    },
  }));
  assert.ok(names(entries).includes('flat/skill/greet'));
  assert.deepEqual(notes, [
    'acme/claude-skills: far live outside the marketplace repo; their contents show once installed (rigup setup)',
    'acme/unregistered: not registered yet, nothing to read (rigup setup)',
  ]);
});

test('scanPlugin honors extra component folders from plugin.json', () => {
  const c = ctx({ files: {
    [`${HOME}/p/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'p', commands: ['./extra-commands'] }),
    [`${HOME}/p/extra-commands/go.md`]: '---\ndescription: Go.\n---\n',
  } });
  assert.deepEqual(scanPlugin(c, `${HOME}/p`).map(f => f.name), ['go']);
});

test('pluginFolder: ./ sources and metadata.pluginRoot; objects are external', () => {
  assert.equal(pluginFolder('/m', {}, { source: './plugins/a' }), '/m/plugins/a');
  assert.equal(pluginFolder('/m', { metadata: { pluginRoot: './plugins' } }, { source: 'a' }), '/m/plugins/a');
  assert.equal(pluginFolder('/m', {}, { source: { source: 'github', repo: 'o/r' } }), null);
});

test('search: every word must match; name beats description beats body; ties by mentions', () => {
  const { entries } = loadCatalog(ctx());
  assert.deepEqual(searchCatalog(entries, 'pull request').map(e => e.name), ['pr-review', 'ship']);
  // Both match by name; reviewer mentions the topic twice (description and body), so it wins the tie.
  assert.deepEqual(searchCatalog(entries, 'review').map(e => e.name).slice(0, 2), ['reviewer', 'pr-review']);
  assert.deepEqual(searchCatalog(entries, 'pull nothinghere'), []);
  assert.deepEqual(searchCatalog(entries, '   '), []);
});

test('usage: /plugin:name for skills and commands, agent plugin:name for agents', () => {
  assert.equal(usage({ kind: 'skill', plugin: 'p', name: 'n' }), '/p:n');
  assert.equal(usage({ kind: 'agent', plugin: 'p', name: 'n' }), 'agent p:n');
});

test('formatList groups by source and plugin and marks what is not installed', () => {
  const { entries } = loadCatalog(ctx());
  const text = formatList(entries, { installed: new Set(['review@acme-skills', 'my-skills@rigup-local']) });
  assert.match(text, /^rigup list · 4 plugins · 3 skills · 1 agents · 1 commands/);
  assert.match(text, /acme\/claude-skills\n {2}docs {2}\(not installed: rigup setup\)/);
  assert.doesNotMatch(text, /review {2}\(not installed/);
  assert.match(text, /reviewer \(agent\)/);
  assert.match(formatList([]), /Nothing yet/);
});

test('formatSearch: how to use each match, top 15 unless --all', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ source: 's', plugin: 'p', pluginId: 'p@m', kind: 'skill', name: `s${i}`, short: '' }));
  assert.match(formatSearch(many, 'x'), /20 matches for "x" \(top 15; --all for every match\)/);
  assert.equal((formatSearch(many, 'x', { limit: Infinity }).match(/use: /g) || []).length, 20);
  assert.match(formatSearch([], 'zzz'), /nothing matches "zzz"/);
});

test('rigup list --json and rigup search: installed flags, exit codes', () => {
  const out = [];
  const io = { log: l => out.push(l), error: l => out.push(l) };
  assert.equal(runList(ctx(), ['--json'], io), 0);
  const json = JSON.parse(out.pop());
  assert.equal(json.entries.find(e => e.name === 'write-docs').installed, false);
  assert.equal(json.entries.find(e => e.name === 'hello').installed, true);
  assert.equal(json.entries[0].body, undefined);
  assert.equal(runSearch(ctx(), ['docs'], io), 0);
  assert.match(out.pop(), /docs · write-docs {2}· not installed: rigup setup\n {4}Writes docs\n {4}use: \/docs:write-docs/);
  assert.equal(runSearch(ctx(), [], io), 2);
  assert.ok(MY_SKILLS && ok);
});
