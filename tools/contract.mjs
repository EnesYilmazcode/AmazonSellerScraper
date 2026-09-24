// tools/contract.mjs: runs the sync contract test against the Firebase
// emulators, with the dashboard repo's firestore.rules.
//
//   node tools/contract.mjs
//
// The rules come from PROSCAN_RULES, else ../web/firestore.rules or
// ../proscan-web/firestore.rules next to this repo. Ports default away from
// the dashboard's (EMU_AUTH_PORT 9299, EMU_FIRESTORE_PORT 8288) so both can
// be checked out side by side. Project is demo-proscan: emulators only.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST = path.join(ROOT, 'tests', 'contract', 'sync.contract.mjs');
const TIMEOUT_MS = 7 * 60 * 1000;

const port = (name, fallback) => {
  const n = Number(process.env[name] || fallback);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} is not a port`);
  return n;
};
const ports = {
  auth: port('EMU_AUTH_PORT', 9299),
  firestore: port('EMU_FIRESTORE_PORT', 8288),
  websocket: port('EMU_WEBSOCKET_PORT', 9250),
  hub: port('EMU_HUB_PORT', 4488),
  logging: port('EMU_LOGGING_PORT', 4588),
};

export function findRules(env = process.env) {
  const candidates = env.PROSCAN_RULES
    ? [path.resolve(env.PROSCAN_RULES)]
    : [path.join(ROOT, '..', 'web', 'firestore.rules'), path.join(ROOT, '..', 'proscan-web', 'firestore.rules')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`firestore.rules not found; tried ${candidates.join(', ')}. Set PROSCAN_RULES.`);
  return found;
}

/** Kills whatever still listens on our ports; on Windows java outlives firebase. */
function freePorts() {
  if (process.platform !== 'win32') return;
  let out = '';
  try {
    out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  } catch {
    return;
  }
  const wanted = new Set(Object.values(ports).map(String));
  const pids = new Set();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m && wanted.has(m[1])) pids.add(m[2]);
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}

function main() {
  const rules = findRules();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proscan-contract-'));
  fs.copyFileSync(rules, path.join(dir, 'firestore.rules'));
  fs.writeFileSync(path.join(dir, 'firebase.json'), JSON.stringify({
    firestore: { rules: 'firestore.rules' },
    emulators: {
      auth: { host: '127.0.0.1', port: ports.auth },
      firestore: { host: '127.0.0.1', port: ports.firestore, websocketPort: ports.websocket },
      hub: { host: '127.0.0.1', port: ports.hub },
      logging: { host: '127.0.0.1', port: ports.logging },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  }, null, 2));
  console.log(`[contract] rules ${rules}`);
  console.log(`[contract] auth ${ports.auth}, firestore ${ports.firestore}`);

  const cmd = `node --test --test-concurrency=1 "${TEST}"`;
  const child = spawn('firebase', [
    'emulators:exec', '--only', 'auth,firestore', '--project', 'demo-proscan',
    '--config', path.join(dir, 'firebase.json'), JSON.stringify(cmd),
  ], { cwd: dir, stdio: 'inherit', shell: true, env: { ...process.env, PROSCAN_CONTRACT_RULES: rules } });

  const timer = setTimeout(() => {
    console.error('[contract] timed out');
    child.kill('SIGTERM');
  }, TIMEOUT_MS);

  const cleanup = () => {
    clearTimeout(timer);
    freePorts();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  child.on('exit', (code, signal) => {
    cleanup();
    process.exit(signal ? 1 : (code ?? 1));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
