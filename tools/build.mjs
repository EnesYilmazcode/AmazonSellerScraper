// tools/build.mjs — builds the extension into dist/.
//
// - Bundles exactly one entry (the MV3 service worker) with esbuild. Today the
//   worker has no imports, so output is semantically identical to the source;
//   this establishes the M3 path for firebase/* npm imports.
// - Copies every other shipped file VERBATIM, preserving paths, so
//   manifest.json needs zero rewriting.
// - Popup files and scripts/modules/* are deliberately NOT bundled:
//   popup.html loads them as plain <script> tags communicating via globals,
//   and bundling would break that contract.
// - Ends with a manifest-closure sanity gate: every path manifest.json
//   references must exist in dist/, else exit nonzero.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Files copied verbatim (paths relative to repo root, preserved in dist/).
export const COPY_FILES = [
  'manifest.json',
  'popup/popup.html',
  'popup/popup.js',
  'popup/popup.css',
  'scripts/content/scraper.js',
  'scripts/content/chatbot.js',
  'scripts/content/offer-fetcher.js',
  'scripts/modules/storage.js',
  'scripts/modules/analyzer.js',
  'scripts/modules/spread-analyzer.js',
  'scripts/modules/exporter.js',
  'libs/xlsx.full.min.js',
  'styles/chatbot.css',
  'assets/icons/icon16.png',
  'assets/icons/icon48.png',
  'assets/icons/icon128.png',
];

// The single bundled entry.
export const BUNDLE_ENTRY = 'scripts/background/service-worker.js';

function fail(msg) {
  console.error(`[build] FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  // 1. Clean dist/.
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // 2. Bundle exactly one entry: the MV3 service worker.
  await build({
    entryPoints: [path.join(ROOT, BUNDLE_ENTRY)],
    outfile: path.join(DIST, BUNDLE_ENTRY),
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    minify: false,
  });

  // 3. Copy everything else verbatim, preserving paths.
  for (const rel of COPY_FILES) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) fail(`source file missing: ${rel}`);
    const dest = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  // 4. Manifest-closure sanity gate.
  const missing = manifestClosureMissing(DIST);
  if (missing.length > 0) {
    fail(`manifest references missing from dist/:\n  - ${missing.join('\n  - ')}`);
  }

  console.log(`[build] OK: dist/ built (${COPY_FILES.length + 1} files), manifest closure verified.`);
}

/**
 * Returns the list of manifest-referenced paths that do NOT exist under
 * `baseDir`. Glob patterns (web_accessible_resources) are resolved against
 * baseDir and must match at least one file.
 */
export function manifestClosureMissing(baseDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(baseDir, 'manifest.json'), 'utf8'));
  const literal = new Set();
  const globs = new Set();

  const add = (p) => {
    if (typeof p !== 'string') return;
    const norm = p.replace(/\\/g, '/').replace(/^\//, '');
    if (norm.includes('*')) globs.add(norm);
    else literal.add(norm);
  };

  if (manifest.action) {
    add(manifest.action.default_popup);
    if (typeof manifest.action.default_icon === 'string') add(manifest.action.default_icon);
    else if (manifest.action.default_icon) Object.values(manifest.action.default_icon).forEach(add);
  }
  if (manifest.icons) Object.values(manifest.icons).forEach(add);
  for (const cs of manifest.content_scripts ?? []) {
    (cs.js ?? []).forEach(add);
    (cs.css ?? []).forEach(add);
  }
  if (manifest.background?.service_worker) add(manifest.background.service_worker);
  for (const war of manifest.web_accessible_resources ?? []) {
    (war.resources ?? []).forEach(add);
  }

  const missing = [];
  for (const rel of literal) {
    if (!fs.existsSync(path.join(baseDir, rel))) missing.push(rel);
  }
  for (const glob of globs) {
    if (!globMatchesAny(baseDir, glob)) missing.push(`${glob} (glob matched no files)`);
  }
  return missing;
}

function globMatchesAny(baseDir, glob) {
  const re = new RegExp(
    '^' +
      glob
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*') +
      '$'
  );
  return listFilesRecursive(baseDir).some((rel) => re.test(rel));
}

export function listFilesRecursive(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// Run only when executed directly (not when imported by zip.mjs).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[build] FAIL:', err);
    process.exit(1);
  });
}
