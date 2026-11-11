// tools/contract.mjs: runs the sync contract test against the Firebase
// emulators, with the dashboard repo's firestore.rules.
//
//   node tools/contract.mjs
//
// The rules come from PROSCAN_RULES, else ../web/firestore.rules or
// ../proscan-web/firestore.rules next to this repo. Ports default away from
// the dashboard's (EMU_AUTH_PORT 9299, EMU_FIRESTORE_PORT 8288) so both can
// be checked out side by side. Project is demo-proscan: emulators only.
//
// It refuses to start when any of its ports is already taken, and on exit it
// only kills processes that listen on its ports and started after it did,
// so another emulator, dev server or agent on those ports is never touched.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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

/** Resolves true when nothing can be bound to 127.0.0.1:`port`. */
function portTaken(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

/** The ports of `list` something already listens on. */
export async function busyPorts(list) {
  const taken = [];
  for (const p of list) if (await portTaken(p)) taken.push(p);
  return taken;
}

/** {port: Set(pid)} for every LISTENING socket on `list`, on any address (Windows only). */
function listeners(list) {
  const out = new Map();
  if (process.platform !== 'win32') return out;
  let text = '';
  try {
    text = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  } catch {
    return out;
  }
  const wanted = new Set(list.map(String));
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m && wanted.has(m[1])) {
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1]).add(m[2]);
    }
  }
  return out;
}

/** When process `pid` started, in ms, or null when that cannot be read. */
function startedAt(pid) {
  try {
    const iso = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * On Windows java outlives firebase, so the emulators this run started can
 * keep our ports. Kills only listeners on our ports that started after
 * `since`; anything older belongs to someone else.
 */
function freeOurPorts(since) {
  for (const pids of listeners(Object.values(ports)).values()) {
    for (const pid of pids) {
      const t = startedAt(pid);
      if (t === null || t < since) continue;
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
  }
}

async function main() {
  const rules = findRules();
  const taken = await busyPorts(Object.values(ports));
  if (taken.length) {
    console.error(`[contract] FAIL: port${taken.length > 1 ? 's' : ''} ${taken.join(', ')} already in use. Nothing was started or stopped.`);
    console.error('[contract] Pick free ports with EMU_AUTH_PORT, EMU_FIRESTORE_PORT, EMU_WEBSOCKET_PORT, EMU_HUB_PORT and EMU_LOGGING_PORT.');
    process.exit(2);
  }
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
  const spawnedAt = Date.now() - 1000;
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
    freeOurPorts(spawnedAt);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  child.on('exit', (code, signal) => {
    cleanup();
    process.exit(signal ? 1 : (code ?? 1));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((err) => { console.error(`[contract] FAIL: ${err.message}`); process.exit(1); });
