// Run: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocal, gitUrls, label, marketplaceAddArg, matchMarketplace, parseSpec, slugify } from '../src/sources.mjs';
import { MARKETPLACES } from './helpers.mjs';

const where = { home: '/home/dev', cwd: '/home/dev/work' };

test('parseSpec: github shorthand, with ref and github: prefix', () => {
  assert.deepEqual(parseSpec('acme/claude-skills', where), { type: 'github', id: 'acme/claude-skills', repo: 'acme/claude-skills', ref: null });
  assert.deepEqual(parseSpec('github:acme/claude-skills@v2', where), { type: 'github', id: 'acme/claude-skills@v2', repo: 'acme/claude-skills', ref: 'v2' });
});

test('parseSpec: git URLs, with an optional #ref', () => {
  assert.equal(parseSpec('https://gitlab.com/acme/skills.git', where).type, 'git');
  assert.deepEqual(parseSpec('git@gitlab.com:acme/skills.git#main', where), {
    type: 'git', id: 'git@gitlab.com:acme/skills.git#main', url: 'git@gitlab.com:acme/skills.git', ref: 'main',
  });
});

test('parseSpec: folders become absolute paths (~, ./, ../, /)', () => {
  assert.equal(parseSpec('~/skills', where).path, '/home/dev/skills');
  assert.equal(parseSpec('./mine', where).path, '/home/dev/work/mine');
  assert.equal(parseSpec('../x', where).path, '/home/dev/x');
  assert.equal(parseSpec('/abs/dir/', where).path, '/abs/dir');
});

test('parseSpec: tells you what it accepts when it cannot tell', () => {
  assert.match(parseSpec('just-a-word', where).error, /owner\/repo, a git URL or a folder path/);
  assert.match(parseSpec('  ', where).error, /empty/);
});

test('marketplaceAddArg and gitUrls per type', () => {
  assert.equal(marketplaceAddArg(parseSpec('acme/s@dev', where)), 'acme/s@dev');
  assert.equal(marketplaceAddArg(parseSpec('https://h/x.git#v1', where)), 'https://h/x.git#v1');
  assert.deepEqual(gitUrls(parseSpec('acme/s', where)), ['git@github.com:acme/s.git', 'https://github.com/acme/s.git']);
  assert.deepEqual(gitUrls(parseSpec('~/x', where)), []);
});

test('matchMarketplace: by repo (case-insensitive), by URL (ignoring .git) and by path', () => {
  assert.equal(matchMarketplace(parseSpec('Acme/Claude-Skills', where), MARKETPLACES).name, 'acme-skills');
  const git = [{ name: 'g', source: 'git', url: 'https://h.com/a/b.git' }];
  assert.equal(matchMarketplace(parseSpec('https://h.com/a/b', where), git).name, 'g');
  assert.equal(matchMarketplace(parseSpec('/home/dev/.local/share/rigup/marketplace', where), MARKETPLACES).name, 'rigup-local');
  assert.equal(matchMarketplace(parseSpec('acme/other', where), MARKETPLACES), null);
});

test('classifyLocal: marketplace > plugin > flat > empty; missing first', () => {
  const folder = (paths, children = []) => ({
    exists: true,
    has: rel => paths.includes(rel),
    children,
    childHas: (name, rel) => paths.includes(`${name}/${rel}`),
  });
  assert.equal(classifyLocal({ exists: false }), 'missing');
  assert.equal(classifyLocal(folder(['.claude-plugin/marketplace.json', 'skills'])), 'marketplace');
  assert.equal(classifyLocal(folder(['agents'])), 'plugin');
  assert.equal(classifyLocal(folder(['.claude-plugin/plugin.json'])), 'plugin');
  assert.equal(classifyLocal(folder(['hello/SKILL.md'], ['hello', 'README.md'])), 'flat');
  assert.equal(classifyLocal(folder(['.hidden/SKILL.md'], ['.hidden'])), 'empty');
  assert.equal(classifyLocal(folder([], ['README.md'])), 'empty');
});

test('slugify and label', () => {
  assert.equal(slugify('My Skills_2024'), 'my-skills-2024');
  assert.equal(slugify('___'), 'skills');
  assert.equal(label(parseSpec('~/work/x', where), '/home/dev'), '~/work/x');
  assert.equal(label(parseSpec('acme/s', where), '/home/dev'), 'acme/s');
});
