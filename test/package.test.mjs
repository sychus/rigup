// Run: node --test test/*.test.mjs
//
// Guards for what npm publishes. npm 11 silently drops a bin entry written as "./file" at
// publish time, which would ship a package with no `rigup` command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('bin points at rigup.mjs without a leading ./', () => {
  assert.deepEqual(pkg.bin, { rigup: 'rigup.mjs' });
});

test('published files include the entry point and src/', () => {
  assert.ok(pkg.files.includes('rigup.mjs'));
  assert.ok(pkg.files.includes('src/'));
});
