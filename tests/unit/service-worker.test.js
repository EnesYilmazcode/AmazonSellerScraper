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

const messageListeners = [];

beforeAll(() => {
  chrome.runtime.onMessage.addListener = (fn) => messageListeners.push(fn);
  chrome.runtime.onInstalled = { addListener() {} };
  chrome.runtime.onStartup = { addListener() {} };
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
