import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkPermissionLock, LIVE_MANIFEST } from '../permission-lock.mjs';

const live = JSON.parse(fs.readFileSync(LIVE_MANIFEST, 'utf8'));
const clone = () => structuredClone(live);

test('the live manifest passes against itself', () => {
  assert.deepEqual(checkPermissionLock(live, live), []);
});

test('removing permissions and hosts passes', () => {
  const m = clone();
  m.permissions = ['storage'];
  m.host_permissions = ['*://*.amazon.com/*'];
  delete m.web_accessible_resources;
  assert.deepEqual(checkPermissionLock(m, live), []);
});

test('an added host permission fails', () => {
  const m = clone();
  m.host_permissions.push('https://firestore.googleapis.com/*');
  assert.match(checkPermissionLock(m, live).join('\n'), /host_permissions adds .*firestore/);
});

test('an added API permission fails', () => {
  const m = clone();
  m.permissions.push('alarms');
  assert.equal(checkPermissionLock(m, live).length, 1);
});

test('optional permissions and optional hosts fail', () => {
  const m = clone();
  m.optional_permissions = ['tabs'];
  m.optional_host_permissions = ['<all_urls>'];
  assert.equal(checkPermissionLock(m, live).length, 2);
});

test('a widened content script match fails', () => {
  const m = clone();
  m.content_scripts[0].matches = ['*://*/*'];
  assert.match(checkPermissionLock(m, live).join('\n'), /content_scripts adds/);
});

test('all_frames on a content script fails', () => {
  const m = clone();
  m.content_scripts[0].all_frames = true;
  assert.equal(checkPermissionLock(m, live).length, 1);
});

test('a widened web_accessible_resources match fails', () => {
  const m = clone();
  m.web_accessible_resources[0].matches.push('<all_urls>');
  assert.equal(checkPermissionLock(m, live).length, 1);
});

test('a new externally_connectable key fails', () => {
  const m = clone();
  m.externally_connectable = { matches: ['https://proscanbot.web.app/*'] };
  assert.match(checkPermissionLock(m, live).join('\n'), /externally_connectable/);
});

test('CSP changes are not permissions and pass', () => {
  const m = clone();
  m.content_security_policy.extension_pages += "; connect-src 'self' https://firestore.googleapis.com";
  assert.deepEqual(checkPermissionLock(m, live), []);
});
