// Run: node --test test/*.test.mjs
//
// Guards for what npm publishes. npm 11 silently drops a bin entry written as "./file" at
// publish time, which would ship a package with no `rigup` command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PACKAGE } from '../src/update.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('bin points at rigup.mjs without a leading ./', () => {
  assert.deepEqual(pkg.bin, { rigup: 'rigup.mjs' });
});

test('published files include the entry point and src/', () => {
  assert.ok(pkg.files.includes('rigup.mjs'));
  assert.ok(pkg.files.includes('src/'));
});

test('rigup update looks itself up by the published name', () => {
  // A rename that only touches package.json would ship a self-update that never finds itself.
  assert.equal(PACKAGE, pkg.name);
  assert.deepEqual(pkg.publishConfig, { access: 'public' });
});
