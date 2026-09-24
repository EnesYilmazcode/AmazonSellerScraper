import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, ALLOWED } from '../secret-scan.mjs';

// Built at runtime so this file does not trip the scan itself.
const fakeKey = 'AI' + 'za' + 'Sy' + 'Q'.repeat(33);

test('finds a plain Google API key', () => {
  const hits = scanText(`const k = '${fakeKey}';`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'Google API key');
});

test('finds a base64-encoded key, as the old Gemini fallback was', () => {
  const b64 = Buffer.from(fakeKey).toString('base64');
  const hits = scanText(`const _t = '${b64}';`);
  assert.equal(hits.length, 1);
  assert.match(hits[0].name, /base64-encoded/);
});

test('finds a base64 key at an odd offset inside a longer blob', () => {
  const b64 = Buffer.from('xy' + fakeKey + 'tail').toString('base64');
  assert.equal(scanText(b64).length, 1);
});

test('reports the line number', () => {
  assert.equal(scanText(`a\nb\n${fakeKey}\n`)[0].line, 3);
});

test('allows the public Firebase web config key', () => {
  const [key] = ALLOWED;
  assert.deepEqual(scanText(`apiKey: '${key}'`), []);
});

test('finds private keys', () => {
  const pem = '-----BEGIN ' + 'PRIVATE KEY-----\nabc\n';
  assert.equal(scanText(pem).length, 1);
});

test('ignores ordinary long identifiers and hashes', () => {
  const text = 'sha512-' + 'a1b2c3d4'.repeat(11) + '\nconst someVeryLongIdentifierNameThatKeepsGoingAndGoing = 1;';
  assert.deepEqual(scanText(text), []);
});
