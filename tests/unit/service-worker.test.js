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
jest.mock('firebase/auth/web-extension', () => {
  const listeners = [];
  return {
    __listeners: listeners,
    onAuthStateChanged: (auth, cb) => {
      listeners.push(cb);
      cb(auth.currentUser);
      return () => {};
    },
    signInWithEmailAndPassword: async () => ({}),
    sendPasswordResetEmail: async () => {},
    signOut: async () => {},
  };
}, { virtual: true });
jest.mock('../../scripts/background/sync.js', () => {
  const flush = jest.fn(async () => ({ entries: 0, pages: 0, runs: 0, products: 0, writes: 0 }));
  return { createSync: () => ({ flush, pending: async () => 0, failed: async () => 0 }), isAuthError: () => false, __flush: flush };
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
const tabUpdatedListeners = [];

beforeAll(() => {
  chrome.runtime.id = 'test-extension';
  chrome.runtime.onMessage.addListener = (fn) => messageListeners.push(fn);
  chrome.runtime.onInstalled = { addListener: (fn) => installedListeners.push(fn) };
  chrome.runtime.onStartup = { addListener: (fn) => startupListeners.push(fn) };
  chrome.tabs.onUpdated = { addListener: (fn) => tabUpdatedListeners.push(fn) };
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

test("Export to ProScan flushes the signed-in account's outbox", async () => {
  flush.mockClear();
  const resp = await send({ type: 'PROSCAN_EXPORT' });
  expect(resp).toMatchObject({ ok: true, entries: 0 });
  // Export also retries entries the rules refused before.
  expect(flush).toHaveBeenCalledWith('u1', { retryFailed: true });
});

test('the auth state says who is signed in and what waits to sync', async () => {
  const st = await send({ type: 'PROSCAN_AUTH_STATE' });
  expect(st).toMatchObject({ user: { uid: 'u1' }, notice: null, pending: 0, failed: 0, dashboardUrl: expect.stringMatching(/^https:/) });
});

test('a password reset answers the same whether or not the account exists (F-56)', async () => {
  const st = await send({ type: 'PROSCAN_RESET_PASSWORD', email: 'nobody@example.test' });
  expect(st).toEqual({ ok: true, message: 'If an account exists for nobody@example.test, a reset link is on its way.' });
  expect(await send({ type: 'PROSCAN_RESET_PASSWORD', email: '' })).toMatchObject({ error: expect.any(String) });
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

test('a session Firebase dropped without a sign-out shows as expired (F-57)', async () => {
  const { auth } = require('../../scripts/background/firebase-init.js');
  const authMod = require('firebase/auth/web-extension');
  const user = auth.currentUser;
  await chrome.storage.local.set({ account: { uid: 'u1', email: 'u1@example.test' } });
  auth.currentUser = null;
  try {
    // The worker's own listener is the first one registered.
    authMod.__listeners[0](null);
    await settle();
    expect(chrome.storage.local._getStore()).toMatchObject({ authNotice: 'expired' });
    expect(chrome.storage.local._getStore()).not.toHaveProperty('account');
    const st = await send({ type: 'PROSCAN_AUTH_STATE' });
    expect(st).toMatchObject({ user: null, notice: 'expired' });
  } finally {
    auth.currentUser = user;
  }
});

test('signing out on purpose clears the account without an expired notice', async () => {
  await chrome.storage.local.set({ account: { uid: 'u1' }, authNotice: 'expired' });
  expect(await send({ type: 'PROSCAN_SIGN_OUT' })).toEqual({ ok: true });
  expect(chrome.storage.local._getStore()).not.toHaveProperty('account');
  expect(chrome.storage.local._getStore()).not.toHaveProperty('authNotice');
});

describe('automatic flushes (EXT9-2)', () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test('a page load in some tab with no run does not flush', async () => {
    // Let flushes asked for before this test go out first.
    await wait(3200);
    await settle();
    flush.mockClear();
    tabUpdatedListeners.forEach((fn) => fn(42, { status: 'loading', url: 'https://www.amazon.com/s?k=x' }, { id: 42 }));
    await settle();
    await wait(3200);
    expect(flush).not.toHaveBeenCalled();
  }, 15000);

  test('after a failed flush the automatic one waits, and Export does not', async () => {
    await chrome.storage.local.set({ lastSync: { at: Date.now(), error: 'unavailable', failures: 2 } });
    flush.mockClear();
    // Opening the popup asks for a flush right away.
    await send({ type: 'PROSCAN_AUTH_STATE' });
    await wait(50);
    await settle();
    expect(flush).not.toHaveBeenCalled();
    await send({ type: 'PROSCAN_EXPORT' });
    expect(flush).toHaveBeenCalledWith('u1', { retryFailed: true });
    expect(chrome.storage.local._getStore().lastSync).toMatchObject({ error: null, failures: 0 });
  });

  test('without a recent failure the popup flush goes out', async () => {
    await chrome.storage.local.set({ lastSync: { at: Date.now() - 2 * 60 * 60 * 1000, error: 'unavailable', failures: 9 } });
    flush.mockClear();
    await send({ type: 'PROSCAN_AUTH_STATE' });
    await wait(50);
    await settle();
    expect(flush).toHaveBeenCalledWith('u1', { retryFailed: false });
  });
});
