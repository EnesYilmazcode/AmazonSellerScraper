// tools/permission-lock.mjs - fails if a manifest asks for anything the live
// store build does not already have. Removals pass; additions fail.
//
//   node tools/permission-lock.mjs [manifest.json ...]
//
// Defaults to dist/manifest.json when it exists, plus the source manifest.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_MANIFEST = path.join(ROOT, 'tools', 'live-manifest.json');

// Keys that grant access on their own. Removing one is fine; adding or
// changing one fails.
export const OPAQUE_KEYS = [
  'externally_connectable',
  'chrome_url_overrides',
  'declarative_net_request',
  'oauth2',
  'key',
];

// Top-level keys a manifest may add over the live one. Every other new key
// fails, so an unknown key (chrome_settings_overrides, devtools_page,
// automation, ...) cannot slip past the lock.
export const SAFE_NEW_KEYS = [
  'author',
  'background',
  'content_security_policy',
  'default_locale',
  'description',
  'homepage_url',
  'icons',
  'minimum_chrome_version',
  'name',
  'short_name',
  'version',
  'version_name',
];

function contentScriptMatches(m) {
  const out = new Set();
  for (const cs of m.content_scripts ?? []) {
    for (const p of cs.matches ?? []) out.add(p);
    // include_globs widen what a match pattern covers
    for (const p of cs.include_globs ?? []) out.add(`include_globs:${p}`);
    if (cs.match_about_blank) out.add('match_about_blank');
    if (cs.match_origin_as_fallback) out.add('match_origin_as_fallback');
    if (cs.all_frames) out.add('all_frames');
    if (cs.world === 'MAIN') out.add('world:MAIN');
  }
  return out;
}

function warMatches(m) {
  const out = new Set();
  for (const war of m.web_accessible_resources ?? []) {
    for (const p of war.matches ?? []) out.add(p);
    for (const id of war.extension_ids ?? []) out.add(`extension_ids:${id}`);
    if (war.use_dynamic_url) out.add('use_dynamic_url');
  }
  return out;
}

function list(m, key) {
  return new Set(m[key] ?? []);
}

/** Returns a list of human-readable violations; empty means the lock holds. */
export function checkPermissionLock(candidate, live) {
  const problems = [];
  const added = (label, cand, base) => {
    for (const v of cand) if (!base.has(v)) problems.push(`${label} adds ${JSON.stringify(v)}`);
  };

  for (const key of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
    added(key, list(candidate, key), list(live, key));
  }
  added('content_scripts', contentScriptMatches(candidate), contentScriptMatches(live));
  added('web_accessible_resources', warMatches(candidate), warMatches(live));

  const checkedAbove = new Set([
    'permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions',
    'content_scripts', 'web_accessible_resources', ...OPAQUE_KEYS,
  ]);
  for (const key of Object.keys(candidate)) {
    if (key in live || SAFE_NEW_KEYS.includes(key) || checkedAbove.has(key)) continue;
    problems.push(`new manifest key "${key}"`);
  }
  for (const key of OPAQUE_KEYS) {
    if (!(key in candidate)) continue;
    if (JSON.stringify(candidate[key]) !== JSON.stringify(live[key])) {
      problems.push(key in live ? `"${key}" changed` : `new manifest key "${key}"`);
    }
  }
  return problems;
}

function main(argv) {
  const live = JSON.parse(fs.readFileSync(LIVE_MANIFEST, 'utf8'));
  let targets = argv;
  if (targets.length === 0) {
    targets = [path.join(ROOT, 'manifest.json')];
    const dist = path.join(ROOT, 'dist', 'manifest.json');
    if (fs.existsSync(dist)) targets.push(dist);
  }
  let failed = false;
  for (const t of targets) {
    const m = JSON.parse(fs.readFileSync(t, 'utf8'));
    const problems = checkPermissionLock(m, live);
    const rel = path.relative(ROOT, t);
    if (problems.length) {
      failed = true;
      console.error(`[permission-lock] FAIL ${rel}:`);
      for (const p of problems) console.error(`  - ${p}`);
    } else {
      console.log(`[permission-lock] OK ${rel}`);
    }
  }
  if (failed) {
    console.error('Any new permission, host or match pattern makes every user re-approve the extension.');
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
