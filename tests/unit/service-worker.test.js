/**
 * The service worker's own handlers, with Firebase and sync mocked out.
 */
jest.mock('../../scripts/background/firebase-init.js', () => ({
  auth: { currentUser: { uid: 'u1', email: 'u1@example.test', displayName: null } },
  db: {},
}));
jest.mock('firebase/auth/web-extension', () => ({
  onAuthStateChanged: (auth, cb) => { cb(auth.currentUser); return () => {}; },
  signInWithEmailAndPassword: async () => ({}),
  signOut: async () => {},
}), { virtual: true });
jest.mock('../../scripts/background/sync.js', () => ({ syncToCloud: jest.fn(async () => ({ written: 1 })) }));

const { syncToCloud } = require('../../scripts/background/sync.js');

const fs = require('fs');
const path = require('path');

const V20 = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/v2.0-storage.json'), 'utf8'));
const messageListeners = [];
const installedListeners = [];
const startupListeners = [];

beforeAll(() => {
  chrome.runtime.onMessage.addListener = (fn) => messageListeners.push(fn);
  chrome.runtime.onInstalled = { addListener: (fn) => installedListeners.push(fn) };
  chrome.runtime.onStartup = { addListener: (fn) => startupListeners.push(fn) };
  chrome.tabs.onRemoved = { addListener() {} };
  require('../../scripts/background/service-worker.js');
});

beforeEach(() => chrome.storage.local._reset());

function send(msg) {
  return new Promise((resolve) => {
    // The sync listener is the second one registered.
    messageListeners[1](msg, {}, resolve);
  });
}

test('Export to ProScan is refused while cloud sync is off (2.1)', async () => {
  chrome.storage.local.set({ syncQueue: [{ asin: 'B000000001', runId: 'r1' }] });
  const resp = await send({ type: 'PROSCAN_EXPORT' });
  expect(resp.error).toMatch(/not available/);
  expect(syncToCloud).not.toHaveBeenCalled();
  expect(chrome.storage.local._getStore().syncQueue).toHaveLength(1);
});

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('an update from 2.0 migrates storage to schema 3 (F-100)', async () => {
  chrome.storage.local.set(JSON.parse(JSON.stringify(V20)));
  installedListeners.forEach((fn) => fn({ reason: 'update', previousVersion: '2.0' }));
  await settle();
  const s = chrome.storage.local._getStore();
  expect(s.schemaVersion).toBe(3);
  expect(s.results).toHaveLength(V20.results.length);
  expect(Object.keys(s.lastValues).sort()).toEqual([...new Set(V20.results.map((r) => r.asin))].sort());
});

test('a browser start finishes a migration an update could not', async () => {
  chrome.storage.local.set(JSON.parse(JSON.stringify(V20)));
  startupListeners.forEach((fn) => fn());
  await settle();
  expect(chrome.storage.local._getStore().schemaVersion).toBe(3);
});

test('a fresh install starts at schema 3', async () => {
  installedListeners.forEach((fn) => fn({ reason: 'install' }));
  await settle();
  expect(chrome.storage.local._getStore()).toMatchObject({ schemaVersion: 3, results: [], isScrapingActive: false });
});
