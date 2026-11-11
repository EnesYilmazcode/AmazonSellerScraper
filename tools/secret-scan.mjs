// tools/secret-scan.mjs - fails on API keys and private keys in the repo or
// the build output. Also decodes long base64 runs, since the old Gemini key
// was shipped base64-encoded.
//
//   node tools/secret-scan.mjs [dir ...]
//
// With no args it scans the files git tracks (plus untracked, unignored ones),
// and dist/ if it exists.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Firebase web API keys are public project identifiers, not secrets. Access is
// governed by the Firestore rules. List each one here explicitly.
export const ALLOWED = new Set([
  'AIzaSyAp0HrcvFwpMxrlqbxa9xjUvwGoTa7QpUU', // proscanbot web app config
]);

const RULES = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'Google OAuth client secret', re: /GOCSPX-[0-9A-Za-z_-]{28}/g },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: 'service account key', re: /"private_key_id"\s*:\s*"[0-9a-f]{40}"/g },
  { name: 'OpenAI or Anthropic key', re: /\bsk-(?:ant-|proj-)?[0-9A-Za-z_-]{32,}/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}/g },
];

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.zip', '.crx', '.woff', '.woff2', '.pdf']);

function scanPlain(text) {
  const hits = [];
  for (const { name, re } of RULES) {
    for (const m of text.matchAll(re)) {
      if (!ALLOWED.has(m[0])) hits.push({ name, value: m[0], index: m.index });
    }
  }
  return hits;
}

/** Returns [{name, value, line}] for every secret found in `text`. */
export function scanText(text) {
  const hits = scanPlain(text);
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{40,}={0,2}/g)) {
    const run = m[0].replace(/-/g, '+').replace(/_/g, '/');
    // A key inside a longer blob can sit at any of four alignments.
    for (let k = 0; k < 4; k++) {
      const decoded = Buffer.from(run.slice(k), 'base64').toString('latin1');
      const found = scanPlain(decoded);
      if (found.length) {
        hits.push({ name: `base64-encoded ${found[0].name}`, value: m[0], index: m.index });
        break;
      }
    }
  }
  return hits.map(({ name, value, index }) => ({
    name,
    value,
    line: text.slice(0, index).split('\n').length,
  }));
}

function listRepoFiles() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT });
  return out.toString('utf8').split('\0').filter(Boolean).map((p) => path.join(ROOT, p));
}

function listDir(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listDir(p));
    else out.push(p);
  }
  return out;
}

function main(argv) {
  let files;
  if (argv.length) {
    files = argv.flatMap((d) => (fs.statSync(d).isDirectory() ? listDir(d) : [d]));
  } else {
    files = listRepoFiles();
    const dist = path.join(ROOT, 'dist');
    if (fs.existsSync(dist)) files.push(...listDir(dist));
  }
  let count = 0;
  for (const f of files) {
    if (BINARY_EXT.has(path.extname(f).toLowerCase()) || !fs.existsSync(f)) continue;
    for (const h of scanText(fs.readFileSync(f, 'utf8'))) {
      count++;
      const shown = h.value.length > 12 ? `${h.value.slice(0, 8)}...` : h.value;
      console.error(`[secret-scan] ${path.relative(ROOT, f)}:${h.line} ${h.name} (${shown})`);
    }
  }
  if (count) {
    console.error(`[secret-scan] FAIL: ${count} secret(s) found. Remove them; revoke any that shipped.`);
    process.exit(1);
  }
  console.log(`[secret-scan] OK: ${files.length} files scanned`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
