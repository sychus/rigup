// Run: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSource, loadConfig, normalizeConfig, removeSource } from '../src/config.mjs';
import { runAdd, runRemove, runSources } from '../src/sources-command.mjs';
import { CONFIG_FILE, fakeContext } from './helpers.mjs';

const where = { home: '/home/dev', cwd: '/home/dev/work' };

test('normalizeConfig: strings and objects, plugins default to "*"', () => {
  const { sources, errors } = normalizeConfig({ sources: ['acme/a', { source: '~/b', plugins: ['x'] }] }, where);
  assert.deepEqual(errors, []);
  assert.deepEqual(sources.map(s => [s.spec.id, s.plugins]), [['acme/a', '*'], ['/home/dev/b', ['x']]]);
});

test('normalizeConfig: reports every bad entry and keeps the good ones', () => {
  const { sources, errors } = normalizeConfig({ sources: ['acme/a', { nope: 1 }, 'word', { source: 'acme/a' }, { source: 'acme/c', plugins: 'some' }] }, where);
  assert.equal(sources.length, 1);
  assert.equal(errors.length, 4);
  assert.match(errors.join('\n'), /sources\[1\]: needs a "source"/);
  assert.match(errors.join('\n'), /listed twice/);
  assert.match(errors.join('\n'), /"plugins" must be/);
  assert.deepEqual(normalizeConfig([], where).errors, ['config must be a JSON object with a "sources" list']);
});

test('loadConfig: missing file is an empty config; invalid JSON is an error', () => {
  assert.deepEqual(loadConfig(fakeContext({ files: { [CONFIG_FILE]: null } })).sources, []);
  assert.match(loadConfig(fakeContext({ files: { [CONFIG_FILE]: '{oops' } })).errors[0], /not valid JSON/);
});

test('addSource stores local paths absolute and refuses duplicates', () => {
  const raw = addSource({ sources: [] }, './mine', where);
  assert.deepEqual(raw.sources, [{ source: '/home/dev/work/mine' }]);
  assert.throws(() => addSource(raw, '/home/dev/work/mine', where), /already a source/);
  assert.deepEqual(addSource({}, 'acme/a', { ...where, plugins: ['x'] }).sources, [{ source: 'acme/a', plugins: ['x'] }]);
});

test('removeSource matches what add stored, however it is typed', () => {
  const raw = { sources: [{ source: '/home/dev/work/mine' }, 'acme/a'] };
  assert.deepEqual(removeSource(raw, '~/work/mine', where).sources, ['acme/a']);
  assert.throws(() => removeSource(raw, 'acme/zzz', where), /is not a source/);
});

test('rigup add writes the config; rigup sources lists it; rigup remove takes it out', () => {
  const ctx = fakeContext({ files: { [CONFIG_FILE]: null } });
  const out = [];
  const io = { log: l => out.push(l), error: l => out.push(l) };
  assert.equal(runAdd(ctx, ['acme/a', '--plugins', 'x,y'], io), 0);
  assert.deepEqual(JSON.parse(ctx.writes.at(-1).content), { sources: [{ source: 'acme/a', plugins: ['x', 'y'] }] });
  assert.equal(runSources(ctx, [], io), 0);
  assert.match(out.join('\n'), /acme\/a {2}\(github\) · x, y/);
  assert.equal(runRemove(ctx, ['acme/a'], io), 0);
  assert.deepEqual(JSON.parse(ctx.writes.at(-1).content), { sources: [] });
});

test('rigup add never overwrites an invalid config', () => {
  const ctx = fakeContext({ files: { [CONFIG_FILE]: '{oops' } });
  const errors = [];
  assert.equal(runAdd(ctx, ['acme/a'], { log: () => {}, error: e => errors.push(e) }), 1);
  assert.equal(ctx.writes.length, 0);
  assert.match(errors[0], /will not overwrite/);
});

test('rigup add with nothing to add explains (exit 2)', () => {
  const errors = [];
  assert.equal(runAdd(fakeContext(), [], { log: () => {}, error: e => errors.push(e) }), 2);
  assert.match(errors[0], /what should I add/);
});
