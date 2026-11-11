// tools/zip.mjs - packages dist/ ONLY into
// dist-zips/proscan-v{version}-{sha}.zip, behind hard gates (any failure exits
// nonzero and writes nothing):
//
//   1. ALLOWLIST       - every file under dist/ must be in the explicit
//                        allowlist (the exact build output set; no sourcemaps,
//                        no strays).
//   2. LEGACY TRIPWIRE - no archive path may match a known legacy/dead-weight
//                        pattern (v1 root files, server/, tests, docs, zips).
//   3. MANIFEST CLOSURE - every file manifest.json references must be present.
//   4. PROD ONLY       - a dev build (emulator origins) never gets zipped.
//   5. PERMISSION LOCK - nothing added over tools/live-manifest.json.
//   6. VERSION GATE    - version above the live one.
//   7. SECRET SCAN     - no API keys in the archive.
//   8. CLEAN TREE      - no uncommitted changes, so the zip matches a commit.
//                        `--allow-dirty` overrides it for local experiments and
//                        stamps the file name with -dirty.
//
// Uses adm-zip; never shells out for packaging, never zips the repo root.

import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COPY_FILES,
  BUNDLE_ENTRY,
  manifestClosureMissing,
  htmlReferencesMissing,
  listFilesRecursive,
} from './build.mjs';
import { checkPermissionLock, LIVE_MANIFEST } from './permission-lock.mjs';
import { compareVersions } from './version-gate.mjs';
import { scanText } from './secret-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
export const ZIP_DIR = path.join(ROOT, 'dist-zips');

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
  /\.md$/i,
  /\.(zip|crx)$/i,
  /\.map$/,
  /(^|\/)\.git(\/|$)/,
];

/** Returns {gate: [problems]} for a built dist dir; empty object means all pass. */
export function zipGateProblems(distDir) {
  const problems = {};
  const add = (gate, list) => {
    if (list.length) problems[gate] = list;
  };
  const archivePaths = listFilesRecursive(distDir).sort();

  const allow = new Set([...COPY_FILES, BUNDLE_ENTRY, 'manifest.json']);
  add('ALLOWLIST', archivePaths.filter((p) => !allow.has(p)).map((p) => `unexpected file: ${p}`));
  add('LEGACY TRIPWIRE', archivePaths
    .filter((p) => LEGACY_PATTERNS.some((re) => re.test(p)))
    .map((p) => `legacy/dead-weight path: ${p}`));
  add('MANIFEST CLOSURE', [...manifestClosureMissing(distDir), ...htmlReferencesMissing(distDir)]);

  const manifestText = fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  add('PROD ONLY', /localhost|127\.0\.0\.1/.test(manifestText)
    ? ['manifest references a local host; this is a dev build (rebuild without PROSCAN_ENV=dev)']
    : []);

  const live = JSON.parse(fs.readFileSync(LIVE_MANIFEST, 'utf8'));
  add('PERMISSION LOCK', checkPermissionLock(manifest, live));
  let versionProblem = [];
  try {
    if (compareVersions(manifest.version, live.version) <= 0) {
      versionProblem = [`version ${manifest.version} is not above the live ${live.version}`];
    }
  } catch (err) {
    versionProblem = [err.message];
  }
  add('VERSION GATE', versionProblem);

  const secrets = [];
  for (const rel of archivePaths.filter((p) => !p.endsWith('.png'))) {
    for (const h of scanText(fs.readFileSync(path.join(distDir, rel), 'utf8'))) {
      secrets.push(`${rel}:${h.line} ${h.name}`);
    }
  }
  add('SECRET SCAN', secrets);
  return problems;
}

/** Returns {sha, dirty}; dirty lists `git status --porcelain` lines. */
export function gitState(cwd = ROOT) {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd }).toString().trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd }).toString().split(/\r?\n/).filter(Boolean);
  return { sha, dirty };
}

function main(argv) {
  const allowDirty = argv.includes('--allow-dirty');
  let git;
  try {
    git = gitState();
  } catch (err) {
    console.error(`[zip] FAIL (CLEAN TREE): cannot read git state (${err.message}).`);
    process.exit(1);
  }
  if (git.dirty.length && !allowDirty) {
    console.error('[zip] FAIL (CLEAN TREE): uncommitted changes; commit them or pass --allow-dirty:');
    for (const line of git.dirty.slice(0, 20)) console.error(`  - ${line}`);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    console.error('[zip] FAIL: dist/ has no manifest.json. Run `npm run build` first.');
    process.exit(1);
  }
  const problems = zipGateProblems(DIST);
  if (Object.keys(problems).length) {
    for (const [gate, list] of Object.entries(problems)) {
      console.error(`[zip] FAIL (${gate}):`);
      for (const line of list) console.error(`  - ${line}`);
    }
    process.exit(1);
  }

  const archivePaths = listFilesRecursive(DIST).sort();
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const outName = `proscan-v${manifest.version}-${git.sha}${git.dirty.length ? '-dirty' : ''}.zip`;
  fs.mkdirSync(ZIP_DIR, { recursive: true });

  const zip = new AdmZip();
  for (const rel of archivePaths) {
    const dir = path.posix.dirname(rel);
    zip.addLocalFile(path.join(DIST, rel), dir === '.' ? '' : dir);
  }
  zip.writeZip(path.join(ZIP_DIR, outName));

  console.log(`[zip] OK: dist-zips/${outName} (${archivePaths.length} files, all gates passed).`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
