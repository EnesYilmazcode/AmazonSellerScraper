import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExtension, manifestForEnv } from '../build.mjs';
import { checkPermissionLock, LIVE_MANIFEST } from '../permission-lock.mjs';

const live = JSON.parse(fs.readFileSync(LIVE_MANIFEST, 'utf8'));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `proscan-${name}-`));
const sw = (dir) => fs.readFileSync(path.join(dir, 'scripts/background/service-worker.js'), 'utf8');
const manifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

test('prod build has no emulator wiring and passes the permission lock', async () => {
  const dir = tmp('prod');
  try {
    await buildExtension({ env: 'prod', outDir: dir });
    const code = sw(dir);
    assert.doesNotMatch(code, /demo-proscan/);
    assert.doesNotMatch(code, /local emulator suite/);
    assert.match(code, /projectId: "proscanbot"/);
    const m = manifest(dir);
    assert.doesNotMatch(JSON.stringify(m), /localhost|127\.0\.0\.1/);
    assert.deepEqual(checkPermissionLock(m, live), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dev build points at demo-proscan and only widens connect-src', async () => {
  const dir = tmp('dev');
  try {
    await buildExtension({ env: 'dev', outDir: dir });
    const code = sw(dir);
    assert.match(code, /projectId: "demo-proscan"/);
    assert.match(code, /local emulator suite/);
    const m = manifest(dir);
    assert.match(m.content_security_policy.extension_pages, /connect-src [^;]*http:\/\/127\.0\.0\.1:9099/);
    assert.deepEqual(m.host_permissions, live.host_permissions);
    assert.deepEqual(checkPermissionLock(m, live), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the prod overlay refuses a manifest that mentions a local host', () => {
  const m = structuredClone(live);
  m.host_permissions.push('http://localhost/*');
  assert.throws(() => manifestForEnv(m, 'prod'), /local host/);
});
