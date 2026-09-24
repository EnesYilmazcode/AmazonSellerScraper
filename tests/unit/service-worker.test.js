/**
 * @jest-environment node
 *
 * The service worker's own handlers, with Firebase and sync mocked out and
 * fake-indexeddb standing in for IndexedDB.
 */
jest.mock('../../scripts/background/firebase-init.js', () => ({
  auth: { currentUser: { uid: 'u1', email: 'u1@example.test', displayName: null } },
  db: {},
}));
jest.mock('firebase/auth/web-extension', () => ({
  onAuthStateChanged: (auth, cb) => { cb(auth.currentUser); return () => {}; },
  signInWithEmailAndPassword: async () => ({}),
  sendPasswordResetEmail: async () => {},
  signOut: async () => {},
}), { virtual: true });
jest.mock('../../scripts/background/sync.js', () => {
  const flush = jest.fn(async () => ({ entries: 0, pages: 0, runs: 0, products: 0, writes: 0 }));
  return { createSync: () => ({ flush, pending: async () => 0 }), isAuthError: () => false, __flush: flush };
});

require('fake-indexeddb/auto');
const { __flush: flush } = require('../../scripts/background/sync.js');
const DB = require('../../scripts/background/db');

const fs = require('fs');
const path = require('path');

const V20 = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/v2.0-storage.json'), 'utf8'));
const messageListeners = [];
const installedListeners = [];
const startupListeners = [];

beforeAll(() => {
  chrome.runtime.id = 'test-extension';
  chrome.runtime.onMessage.addListener = (fn) => messageListeners.push(fn);
  chrome.runtime.onInstalled = { addListener: (fn) => installedListeners.push(fn) };
  chrome.runtime.onStartup = { addListener: (fn) => startupListeners.push(fn) };
  require('../../scripts/background/service-worker.js');
});

beforeEach(() => {
  chrome.storage.local._reset();
  chrome.storage.session._reset();
});

function send(msg, sender = { id: 'test-extension' }) {
  return new Promise((resolve) => {
    const held = messageListeners[0](msg, sender, resolve);
    if (!held) setTimeout(() => resolve('no answer'), 0);
  });
}

async function settle() {
  for (let i = 0; i < 400; i++) await new Promise((r) => setImmediate(r));
}

test('one router answers every message', () => {
  expect(messageListeners).toHaveLength(1);
});

test('Export to ProScan is refused while cloud sync is off', async () => {
  const resp = await send({ type: 'PROSCAN_EXPORT' });
  expect(resp.error).toMatch(/not available/);
  expect(flush).not.toHaveBeenCalled();
});

test('messages meant for the popup or a tab are left alone', async () => {
  expect(await send({ type: 'SPREAD_PROGRESS', current: 1, total: 2 })).toBe('no answer');
  expect(await send({ type: 'PING' })).toBe('no answer');
});

test('an update from 2.0 migrates storage to schema 4, into IndexedDB (F-100)', async () => {
  chrome.storage.local.set(JSON.parse(JSON.stringify(V20)));
  installedListeners.forEach((fn) => fn({ reason: 'update', previousVersion: '2.0' }));
  await settle();
  expect(chrome.storage.local._getStore()).toEqual({ schemaVersion: 4 });
  const st = await send({ type: 'GET_STATE' });
  expect(st.results).toHaveLength(V20.results.length);
  const db = await DB.open();
  expect(await db.count('lastValues')).toBe(new Set(V20.results.map((r) => r.asin)).size);
  db.close();
});

test('a browser start finishes a migration an update could not', async () => {
  chrome.storage.local.set(JSON.parse(JSON.stringify(V20)));
  startupListeners.forEach((fn) => fn());
  await settle();
  expect(chrome.storage.local._getStore().schemaVersion).toBe(4);
});

test('a fresh install writes only settings and the schema version', async () => {
  installedListeners.forEach((fn) => fn({ reason: 'install' }));
  await settle();
  expect(chrome.storage.local._getStore()).toEqual({ schemaVersion: 4, settings: { maxPages: 20 } });
});

test('the chat reads the key from settings and the run from IndexedDB', async () => {
  chrome.storage.local.set({ geminiApiKey: 'k', schemaVersion: 4 });
  const st = await send({ type: 'CHAT_STATUS' }, { id: 'test-extension', tab: { id: 3 } });
  expect(st).toMatchObject({ hasKey: true });
});
