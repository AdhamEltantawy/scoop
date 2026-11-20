import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../social-core.js');

test('build numbers come out of release tags and version names', () => {
  assert.equal(core.releaseNumber('v1.0.42'), 42);
  assert.equal(core.releaseNumber('1.0.7'), 7);
  assert.equal(core.releaseNumber('1.0.0'), null, 'a local build has no number');
  assert.equal(core.releaseNumber('latest'), null);
  assert.equal(core.releaseNumber(undefined), null);
});

test('an update is offered only when the latest release is newer', () => {
  assert.equal(core.updateAvailable('1.0.41', 'v1.0.42'), true);
  assert.equal(core.updateAvailable('1.0.100', 'v1.0.99'), false, 'compared as numbers, not text');
  assert.equal(core.updateAvailable('1.0.42', 'v1.0.42'), false);
  assert.equal(core.updateAvailable('1.0.0', 'v1.0.42'), false, 'local builds are left alone');
  assert.equal(core.updateAvailable('1.0.41', 'nightly'), false);
});
