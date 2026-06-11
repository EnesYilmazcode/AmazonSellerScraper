// tools/zip.mjs — packages dist/ ONLY into proscan-v{manifest.version}.zip
// at the repo root, behind three hard gates (each exits nonzero on failure):
//
//   1. ALLOWLIST       — every file under dist/ must be in the explicit
//                        allowlist (the exact build output set; no sourcemaps,
//                        no strays).
//   2. LEGACY TRIPWIRE — no archive path may match a known legacy/dead-weight
//                        pattern (v1 root files, server/, tests, docs, etc.).
//   3. MANIFEST CLOSURE — every file manifest.json references must be present
//                        in the archive.
//
// Uses adm-zip; never shells out, never zips the repo root.

import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COPY_FILES,
  BUNDLE_ENTRY,
  manifestClosureMissing,
  listFilesRecursive,
} from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

function fail(gate, lines) {
  console.error(`[zip] FAIL (${gate}):`);
  for (const line of lines) console.error(`  - ${line}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  fail('PRECONDITION', ['dist/ is missing or has no manifest.json — run `npm run build` first.']);
}

// Archive contents = every file under dist/, recursively (forward-slash paths).
const archivePaths = listFilesRecursive(DIST).sort();

// ---- Gate 1: ALLOWLIST -----------------------------------------------------
const ALLOWLIST = new Set([...COPY_FILES, BUNDLE_ENTRY]);
const notAllowed = archivePaths.filter((p) => !ALLOWLIST.has(p));
if (notAllowed.length > 0) {
  fail('ALLOWLIST', notAllowed.map((p) => `unexpected file in dist/: ${p}`));
}

// ---- Gate 2: LEGACY TRIPWIRE -----------------------------------------------
const LEGACY_PATTERNS = [
  /^(popup|background|contentscript)\.(js|html|css)$/, // legacy v1 root files
  /^icon(16|48|128)\.png$/,                            // legacy root icons
  /(^|\/)logo\.png$/,
  /(^|\/)server\//,
  /(^|\/)tests?\//,
  /(^|\/)\.env(\.|$)/,
  /\.py$/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)docs\//,
  /(^|\/)README[^/]*$/,
  /(^|\/)CLAUDE[^/]*$/,
];
const legacyHits = archivePaths.filter((p) => LEGACY_PATTERNS.some((re) => re.test(p)));
if (legacyHits.length > 0) {
  fail('LEGACY TRIPWIRE', legacyHits.map((p) => `legacy/dead-weight path in archive: ${p}`));
}

// ---- Gate 3: MANIFEST CLOSURE ----------------------------------------------
// The archive contains exactly the files under dist/, so closure against
// dist/ is closure against the archive.
const missing = manifestClosureMissing(DIST);
if (missing.length > 0) {
  fail('MANIFEST CLOSURE', missing.map((p) => `manifest references file not in archive: ${p}`));
}

// ---- Package ----------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const outName = `proscan-v${manifest.version}.zip`;
const outPath = path.join(ROOT, outName);

const zip = new AdmZip();
for (const rel of archivePaths) {
  const dir = path.posix.dirname(rel);
  zip.addLocalFile(path.join(DIST, rel), dir === '.' ? '' : dir);
}
zip.writeZip(outPath);

console.log(`[zip] OK: ${outName} (${archivePaths.length} files, all gates passed).`);
