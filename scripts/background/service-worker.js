import { auth } from './firebase-init.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth/web-extension';
import { syncToCloud } from './sync.js';
import { createRouter } from './router.js';
import { createEngine } from './engine.js';
import DB from './db.js';
import Chat from '../lib/chat.js';
import Run from '../lib/run.js';
import Flags from '../lib/flags.js';
import Migrate from '../lib/migrate.js';
import Msg from '../lib/messages.js';

/**
 * @fileoverview Background Service Worker
 *
 * The only writer. It runs scrapes (engine.js), keeps what they collect in
 * IndexedDB (db.js), answers the popup and the content scripts through one
 * router (router.js), calls Gemini for the chat, and migrates storage on
 * install, update and browser start.
 *
 * Runs as a Manifest V3 service worker: no persistent background page.
 * Chrome stops it when idle, so nothing here keeps state in memory that a
 * run needs. The run lives in chrome.storage.session and IndexedDB.
 *
 * @module ServiceWorker
 */

const openDb = () => DB.open();
const engine = createEngine({ chrome, openDb });
const router = createRouter({ extensionId: chrome.runtime.id });

const chatDeps = {
  getStorage: (keys) => engine.chatData(keys),
  fetchFn: (url, init) => fetch(url, init),
};

// The run
router.on(Msg.T.START_RUN, (m) => engine.start(m));
router.on(Msg.T.STOP_RUN, () => engine.stop());
router.on(Msg.T.GET_STATE, () => engine.getState());
router.on(Msg.T.PAGE_READY, (m, sender) => engine.pageReady(m, sender));
router.on(Msg.T.PAGE_RESULT, (m, sender) => engine.pageResult(m, sender));
router.on(Msg.T.HEARTBEAT, (m, sender) => engine.heartbeat(m, sender));

// Spread analysis
router.on(Msg.T.GET_RESULTS, () => engine.getResults());
router.on(Msg.T.SPREAD_RESULT, (m) => engine.spreadResult(m));

// Chat: the key and the run are read here, so the key never passes through the page.
router.on(Msg.T.CHAT_STATUS, () =>
  Chat.status(chatDeps).catch(() => ({ hasKey: false, productCount: 0 })));
router.on(Msg.T.CHAT_MESSAGE, (m) =>
  Chat.answerQuestion({ question: m.question, history: m.history }, chatDeps)
    .catch((err) => ({ error: 'Chat failed: ' + err.message })));

/** Brings stored data to the current schema. Safe to call any number of times. */
function migrate() {
  return Migrate.run(chrome.storage.local, { openDb }).then((done) => {
    if (done) console.log(`[ProScan] Storage migrated from schema ${done.from} to ${done.to}`);
  }, (err) => {
    console.error('[ProScan] Storage migration failed, will retry:', err && err.message);
  });
}

/**
 * On a fresh install only the settings and the schema version go into
 * chrome.storage.local. On an update, whatever the previous version stored
 * is migrated.
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[ProScan] Extension installed');
    chrome.storage.local.set({
      settings: { maxPages: Run.DEFAULT_MAX_PAGES },
      schemaVersion: Migrate.CURRENT,
    });
  } else if (details.reason === 'update') {
    console.log('[ProScan] Extension updated to version', chrome.runtime.getManifest().version);
    migrate().then(() => engine.recover());
  }
});

// A run cannot survive a browser restart, since its tab id is gone.
chrome.runtime.onStartup.addListener(() => {
  migrate().then(() => engine.recover());
});

// Neither listener needs the tabs permission.
chrome.tabs.onRemoved.addListener((tabId) => { engine.tabRemoved(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { engine.tabUpdated(tabId, info, tab); });

// ════════════════════════════════════════════════════════════════════════════
// M3 cloud sync — Firebase Auth (extension-native) + Firestore write path.
// The popup is a plain (unbundled) page; it drives sign-in / export by sending
// these messages to the worker, which owns the single Firebase instance.
// ════════════════════════════════════════════════════════════════════════════

/** Resolve the current Firebase user, waiting for auth to rehydrate from
 *  IndexedDB after a cold service-worker start. */
function currentUser() {
  return new Promise((resolve) => {
    if (auth.currentUser) return resolve(auth.currentUser);
    const unsub = onAuthStateChanged(auth, (u) => {
      unsub();
      resolve(u);
    });
  });
}

/** Trim a Firebase user to the popup-safe shape. */
const publicUser = (u) =>
  u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null;

/** Map Firebase auth error codes to friendly popup messages. */
function friendlyAuthError(err) {
  switch (err && err.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email or password is incorrect.';
    case 'auth/invalid-email':
      return 'That email address does not look valid.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a minute and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection.';
    case 'auth/operation-not-allowed':
      return 'Email sign-in is not enabled for this project yet.';
    default:
      return ((err && err.message) || 'Sign-in failed.').replace(/^Firebase:\s*/, '');
  }
}

router.on(Msg.T.PROSCAN_AUTH_STATE, async () => ({ user: publicUser(await currentUser()) }));

router.on(Msg.T.PROSCAN_SIGN_IN, (m) =>
  signInWithEmailAndPassword(auth, m.email, m.password)
    .then((cred) => ({ user: publicUser(cred.user) }))
    .catch((err) => ({ error: friendlyAuthError(err) })));

router.on(Msg.T.PROSCAN_SIGN_OUT, () =>
  signOut(auth).then(() => ({ ok: true }), (err) => ({ error: err.message })));

router.on(Msg.T.PROSCAN_EXPORT, async () => {
  if (!Flags.CLOUD_SYNC) return { error: 'Export to ProScan is not available in this version.' };
  const user = await currentUser();
  if (!user) return { error: 'Sign in to ProScan first.' };
  const { bundle, seqs } = await engine.outboxBundle();
  if (bundle.syncQueue.length === 0) return { ok: true, written: 0, products: 0 };
  try {
    const result = await syncToCloud(user.uid, bundle);
    // Only what was written leaves the outbox; lastValues stays for deltas.
    await engine.clearOutbox(seqs);
    return { ok: true, ...result };
  } catch (err) {
    console.error('[ProScan] cloud export failed', err);
    return { error: (err && err.message) || 'Export failed.' };
  }
});

chrome.runtime.onMessage.addListener(router.listener);

// A worker started by any event picks up a run that is due its next page.
engine.tick();
