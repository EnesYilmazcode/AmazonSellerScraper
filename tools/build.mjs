// tools/build.mjs — builds the extension into dist/.
//
// - Bundles exactly one entry (the MV3 service worker, with firebase/*) with
//   esbuild.
// - Copies every other shipped file verbatim, preserving paths. manifest.json
//   is the prod manifest; `PROSCAN_ENV=dev` adds the emulator origins to
//   connect-src (see manifestForEnv) and points Firebase at demo-proscan.
// - Popup files and scripts/modules/* are deliberately NOT bundled:
//   popup.html loads them as plain <script> tags communicating via globals,
//   and bundling would break that contract.
// - Ends with closure gates: every path manifest.json or a built HTML page
//   references must exist in dist/, else exit nonzero.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Files copied verbatim (paths relative to repo root, preserved in dist/).
// manifest.json is written separately by manifestForEnv.
export const COPY_FILES = [
  'popup/popup.html',
  'popup/popup.js',
  'popup/ai-key.js',
  'popup/popup.css',
  'scripts/content/scraper.js',
  'scripts/content/chatbot.js',
  'scripts/content/offer-fetcher.js',
  'scripts/lib/parsers.js',
  'scripts/lib/messages.js',
  'scripts/lib/run.js',
  'scripts/lib/flags.js',
  'scripts/modules/price.js',
  'scripts/modules/delta.js',
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

export const EMULATOR_ORIGINS = ['http://127.0.0.1:9099', 'http://127.0.0.1:8080'];

/**
 * Returns the manifest to ship for `env`. Prod is the source manifest as is,
 * and must not mention a local host. Dev only widens CSP connect-src, which
 * is not a permission.
 */
export function manifestForEnv(base, env) {
  const m = structuredClone(base);
  if (env === 'dev') {
    const csp = m.content_security_policy.extension_pages;
    m.content_security_policy.extension_pages = csp.replace(
      /connect-src ([^;]*)/,
      (_, list) => `connect-src ${list} ${EMULATOR_ORIGINS.join(' ')}`
    );
    return m;
  }
  if (/localhost|127\.0\.0\.1/.test(JSON.stringify(m))) {
    throw new Error('prod manifest references a local host');
  }
  return m;
}

// The single bundled entry.
export const BUNDLE_ENTRY = 'scripts/background/service-worker.js';

/** Builds the extension for `env` into `outDir`. Throws on any failed gate. */
export async function buildExtension({ env = 'prod', outDir = DIST } = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const manifest = manifestForEnv(base, env);

  // 1. Clean the output dir.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 2. Bundle exactly one entry: the MV3 service worker.
  await build({
    entryPoints: [path.join(ROOT, BUNDLE_ENTRY)],
    outfile: path.join(outDir, BUNDLE_ENTRY),
    bundle: true,
    format: 'iife',
    target: 'chrome114',
    platform: 'browser',
    // firebase/* reads process.env.NODE_ENV; inline it so the bundle has no
    // bare `process` (undefined in a service worker). __PROSCAN_EMULATOR__
    // is a literal the dev build flips to wire up the emulators.
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __PROSCAN_EMULATOR__: env === 'dev' ? 'true' : 'false',
    },
    minify: false,
    // Folds the __PROSCAN_EMULATOR__ branches so prod carries no emulator code.
    minifySyntax: true,
    logLevel: 'silent',
  });

  // 3. Copy everything else verbatim, preserving paths.
  for (const rel of COPY_FILES) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) throw new Error(`source file missing: ${rel}`);
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 4) + '\n');

  // 4. Closure gates: everything the manifest and the HTML pages load must exist.
  const missing = [...manifestClosureMissing(outDir), ...htmlReferencesMissing(outDir)];
  if (missing.length > 0) {
    throw new Error(`references missing from the build:\n  - ${missing.join('\n  - ')}`);
  }
  return { env, outDir, fileCount: listFilesRecursive(outDir).length };
}

/**
 * Returns local script/stylesheet/image references in every built HTML page
 * that do not resolve to a file. Remote URLs are skipped.
 */
export function htmlReferencesMissing(baseDir) {
  const missing = [];
  for (const rel of listFilesRecursive(baseDir).filter((p) => p.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(baseDir, rel), 'utf8');
    for (const m of html.matchAll(/<(?:script|link|img)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      const ref = m[1];
      if (/^(?:[a-z]+:)?\/\//i.test(ref) || /^(?:data|#)/i.test(ref)) continue;
      const target = path.join(baseDir, path.dirname(rel), ref.split(/[?#]/)[0]);
      if (!fs.existsSync(target)) missing.push(`${rel} -> ${ref}`);
    }
  }
  return missing;
}

async function main() {
  const dev = process.env.PROSCAN_ENV === 'dev' || process.argv.includes('--dev');
  const env = dev ? 'dev' : 'prod';
  try {
    const { fileCount } = await buildExtension({ env });
    console.log(`[build] OK: ${env} dist/ built (${fileCount} files), closure verified.`);
  } catch (err) {
    console.error(`[build] FAIL: ${err.message ?? err}`);
    process.exit(1);
  }
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
if (invokedDirectly) main();
