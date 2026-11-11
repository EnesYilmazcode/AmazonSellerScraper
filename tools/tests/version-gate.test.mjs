import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareVersions, parseVersion } from '../version-gate.mjs';

test('compares dotted versions numerically', () => {
  assert.equal(compareVersions('2.1.0', '2.0'), 1);
  assert.equal(compareVersions('2.0.0', '2.0'), 0);
  assert.equal(compareVersions('2.10', '2.9'), 1);
  assert.equal(compareVersions('1.9.9.9', '2.0'), -1);
});

test('rejects versions Chrome would reject', () => {
  for (const v of ['2.1.0-beta', '02.1', '1.2.3.4.5', '70000', '', 'v2']) {
    assert.throws(() => parseVersion(v), /invalid/);
  }
});

test('the source manifest is above the live version', () => {
  const src = JSON.parse(fs.readFileSync(new URL('../../manifest.json', import.meta.url)));
  const live = JSON.parse(fs.readFileSync(new URL('../live-manifest.json', import.meta.url)));
  assert.equal(compareVersions(src.version, live.version), 1);
});
