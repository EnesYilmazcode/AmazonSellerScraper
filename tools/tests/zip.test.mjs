import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExtension } from '../build.mjs';
import { zipGateProblems } from '../zip.mjs';

let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proscan-zip-'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const fresh = (env = 'prod') => buildExtension({ env, outDir: dir });

test('a clean prod build passes every gate', async () => {
  await fresh();
  assert.deepEqual(zipGateProblems(dir), {});
});

test('stray zips, markdown and server files are rejected', async () => {
  await fresh();
  fs.writeFileSync(path.join(dir, 'proscan-v2.0.zip'), 'x');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x');
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'server/app.py'), 'x');
  const p = zipGateProblems(dir);
  assert.equal(p.ALLOWLIST.length, 3);
  assert.equal(p['LEGACY TRIPWIRE'].length, 3);
});

test('a dev build is refused', async () => {
  await fresh('dev');
  assert.ok(zipGateProblems(dir)['PROD ONLY']);
});

test('an escalated or unbumped manifest is refused', async () => {
  await fresh();
  const mp = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.host_permissions.push('https://firestore.googleapis.com/*');
  m.version = '2.0';
  fs.writeFileSync(mp, JSON.stringify(m));
  const p = zipGateProblems(dir);
  assert.ok(p['PERMISSION LOCK']);
  assert.ok(p['VERSION GATE']);
});

test('a key in the bundle is refused', async () => {
  await fresh();
  const swPath = path.join(dir, 'scripts/background/service-worker.js');
  const key = Buffer.from('AI' + 'zaSy' + 'Z'.repeat(33)).toString('base64');
  fs.appendFileSync(swPath, `\nconst _t = '${key}';\n`);
  assert.ok(zipGateProblems(dir)['SECRET SCAN']);
});
