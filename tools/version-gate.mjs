// tools/version-gate.mjs - the store rejects an upload whose version is not
// above the published one. Fails unless the manifest version is greater than
// tools/live-manifest.json.
//
//   node tools/version-gate.mjs [manifest.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_MANIFEST } from './permission-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Chrome versions are 1 to 4 dot-separated integers, 0 to 65535, no leading zeros.
export function parseVersion(v) {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(v)) {
    throw new Error(`invalid Chrome version "${v}"`);
  }
  const parts = v.split('.').map(Number);
  if (parts.some((n) => n > 65535)) throw new Error(`invalid Chrome version "${v}"`);
  return parts;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

function main(argv) {
  const target = argv[0] ?? path.join(ROOT, 'manifest.json');
  const live = JSON.parse(fs.readFileSync(LIVE_MANIFEST, 'utf8')).version;
  const built = JSON.parse(fs.readFileSync(target, 'utf8')).version;
  let cmp;
  try {
    cmp = compareVersions(built, live);
  } catch (err) {
    console.error(`[version-gate] FAIL: ${err.message}`);
    process.exit(1);
  }
  if (cmp <= 0) {
    console.error(`[version-gate] FAIL: version ${built} is not above the live ${live}`);
    process.exit(1);
  }
  console.log(`[version-gate] OK: ${built} > live ${live}`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
