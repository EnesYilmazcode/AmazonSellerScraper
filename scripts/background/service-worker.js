import { auth, db as firestore } from './firebase-init.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'firebase/auth/web-extension';
import { createSync, isAuthError } from './sync.js';
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
// Saved pages and ended runs wake the sync; see scheduleFlush below.
const thenFlush = (p) => p.then((out) => { scheduleFlush(); return out; });

router.on(Msg.T.START_RUN, (m) => engine.start(m));
router.on(Msg.T.STOP_RUN, () => thenFlush(engine.stop()));
router.on(Msg.T.GET_STATE, () => engine.getState());
router.on(Msg.T.PAGE_READY, (m, sender) => engine.pageReady(m, sender));
router.on(Msg.T.PAGE_RESULT, (m, sender) => thenFlush(engine.pageResult(m, sender)));
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
    migrate().then(() => engine.recover('updated')).then(() => scheduleFlush());
  }
});

// A run cannot survive a browser restart, since its tab id is gone.
chrome.runtime.onStartup.addListener(() => {
  migrate().then(() => engine.recover()).then(() => scheduleFlush());
});

// Neither listener needs the tabs permission.
chrome.tabs.onRemoved.addListener((tabId) => { thenFlush(engine.tabRemoved(tabId)); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { thenFlush(engine.tabUpdated(tabId, info, tab)); });

// ── ProScan account and cloud sync ──────────────────────────────────────────
// The popup is a plain page; it signs in and exports through these messages,
// and the worker owns the one Firebase instance.
//
// storage.local keeps `account` {uid, email} while signed in, so the engine
// queues pages for that account, and `authNotice` 'expired' when Firebase
// dropped the session without the user signing out.

const DASHBOARD_URL = 'https://proscanbot.web.app/dashboard/';
const FLUSH_DELAY_MS = 3000;
let flushTimer = null;

const sync = createSync({ db: firestore, openStore: () => engine.db() });

/** Resolve the current Firebase user, waiting for auth to rehydrate from
 *  IndexedDB after a cold service-worker start. */
function currentUser() {
  return new Promise((resolve) => {
    if (auth.currentUser) return resolve(auth.currentUser);
    let settled = false;
    let unsub = null;
    unsub = onAuthStateChanged(auth, (u) => {
      if (settled) return;
      settled = true;
      if (unsub) unsub();
      resolve(u);
    });
    // The first answer can come before onAuthStateChanged returns.
    if (settled) unsub();
  });
}

/** Trim a Firebase user to the popup-safe shape. */
const publicUser = (u) =>
  u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null;

let signingOut = false;

async function rememberAccount(user) {
  if (user) {
    await chrome.storage.local.set({ account: { uid: user.uid, email: user.email || null } });
    await chrome.storage.local.remove('authNotice');
    return;
  }
  const { account } = await chrome.storage.local.get('account');
  if (!account) return;
  await chrome.storage.local.remove('account');
  // Signed out without asking: the refresh token was revoked or expired.
  if (!signingOut) await chrome.storage.local.set({ authNotice: 'expired' });
}

onAuthStateChanged(auth, (user) => {
  rememberAccount(user).catch(() => {});
  if (user) scheduleFlush();
});

/** Firebase refused the session: sign out and say so in the popup. */
async function expireSession() {
  await chrome.storage.local.set({ authNotice: 'expired' });
  await chrome.storage.local.remove('account');
  await signOut(auth).catch(() => {});
}

/** Writes the outbox for the signed-in account now. */
async function flushNow() {
  if (!Flags.CLOUD_SYNC) return { skipped: true };
  const user = await currentUser();
  if (!user) return { skipped: true };
  try {
    const out = await sync.flush(user.uid);
    await chrome.storage.local.set({ lastSync: { at: Date.now(), error: null } });
    return out;
  } catch (err) {
    await chrome.storage.local.set({ lastSync: { at: Date.now(), error: (err && err.code) || 'unknown' } });
    if (isAuthError(err)) await expireSession();
    throw err;
  }
}

/**
 * Flushes a few seconds after the last page or run end, on wake events the
 * worker already gets. No alarm: the timer dies with the worker, and what
 * it missed goes out on the next wake.
 */
function scheduleFlush(ms = FLUSH_DELAY_MS) {
  if (!Flags.CLOUD_SYNC) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow().catch(() => {});
  }, ms);
}

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
      return 'Sign-in failed. Try again.';
  }
}

router.on(Msg.T.PROSCAN_AUTH_STATE, async () => {
  const user = await currentUser();
  const { authNotice, lastSync } = await chrome.storage.local.get(['authNotice', 'lastSync']);
  // Opening the popup is a wake event too.
  if (user) scheduleFlush(0);
  return {
    user: publicUser(user),
    notice: user ? null : authNotice || null,
    pending: user ? await sync.pending(user.uid).catch(() => 0) : 0,
    lastSync: lastSync || null,
    dashboardUrl: DASHBOARD_URL,
  };
});

router.on(Msg.T.PROSCAN_SIGN_IN, (m) =>
  signInWithEmailAndPassword(auth, String(m.email || ''), String(m.password || ''))
    .then(async (cred) => {
      await rememberAccount(cred.user);
      scheduleFlush(0);
      return { user: publicUser(cred.user) };
    })
    .catch((err) => ({ error: friendlyAuthError(err) })));

// The same answer whether or not the account exists.
router.on(Msg.T.PROSCAN_RESET_PASSWORD, async (m) => {
  const email = String(m.email || '').trim();
  if (!email) return { error: 'Enter your email first.' };
  try {
    await sendPasswordResetEmail(auth, email, { url: DASHBOARD_URL });
  } catch (err) {
    if (err && err.code === 'auth/invalid-email') return { error: 'That email address does not look valid.' };
    if (err && err.code === 'auth/network-request-failed') return { error: 'Network error. Check your connection.' };
  }
  return { ok: true, message: `If an account exists for ${email}, a reset link is on its way.` };
});

router.on(Msg.T.PROSCAN_SIGN_OUT, async () => {
  signingOut = true;
  try {
    await signOut(auth);
    await chrome.storage.local.remove(['account', 'authNotice']);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  } finally {
    signingOut = false;
  }
});

router.on(Msg.T.PROSCAN_EXPORT, async () => {
  if (!Flags.CLOUD_SYNC) return { error: 'Export to ProScan is not available in this version.' };
  const user = await currentUser();
  if (!user) return { error: 'Sign in to ProScan first.' };
  try {
    return { ok: true, ...(await flushNow()) };
  } catch (err) {
    if (isAuthError(err)) return { error: 'Your session expired. Sign in again to keep syncing.', expired: true };
    return { error: 'Could not reach ProScan. Your scans are kept and will sync later.' };
  }
});

chrome.runtime.onMessage.addListener(router.listener);

// A worker started by any event picks up a run that is due its next page.
engine.tick();
