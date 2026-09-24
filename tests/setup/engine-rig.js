/**
 * An in-process extension for the run engine tests: the real router and
 * engine over fake-indexeddb, and the real scraper.js loaded into a JSDOM
 * page per tab. Messages go between them the way Chrome routes them.
 * tabs.update loads the next page from `site(url)`.
 *
 * Use jest fake timers with setImmediate left real (fake-indexeddb runs on
 * it), then drive time with rig.advance(ms).
 */
require('fake-indexeddb/auto');
const { IDBFactory } = require('fake-indexeddb');
const { loadContentScript } = require('./dom-helpers');
const DB = require('../../scripts/background/db');
const { createEngine } = require('../../scripts/background/engine');
const { createRouter } = require('../../scripts/background/router');

const EXT_ID = 'test-extension';

function memoryArea(initial = {}) {
  let store = JSON.parse(JSON.stringify(initial));
  let failNext = null;
  return {
    async get(keys) {
      const list = keys == null ? Object.keys(store) : [].concat(keys);
      const out = {};
      list.forEach((k) => { if (store[k] !== undefined) out[k] = JSON.parse(JSON.stringify(store[k])); });
      return out;
    },
    async set(items) {
      if (failNext) { const m = failNext; failNext = null; throw new Error(m); }
      Object.assign(store, JSON.parse(JSON.stringify(items)));
    },
    async remove(keys) { [].concat(keys).forEach((k) => delete store[k]); },
    dump: () => JSON.parse(JSON.stringify(store)),
    _failNext(m = 'QUOTA_BYTES quota exceeded') { failNext = m; },
  };
}

/** Timers that can all be cleared at once, as when a page or the worker goes away. */
function timerSet() {
  const live = new Set();
  return {
    setTimeout(fn, ms) { const id = setTimeout(() => { live.delete(id); fn(); }, ms); live.add(id); return id; },
    clearTimeout(id) { live.delete(id); clearTimeout(id); },
    setInterval(fn, ms) { const id = setInterval(fn, ms); live.add(id); return id; },
    clearInterval(id) { live.delete(id); clearInterval(id); },
    clearAll() { live.forEach((id) => { clearTimeout(id); clearInterval(id); }); live.clear(); },
  };
}

function createRig({ site, flags, local = {}, now = () => Date.now(), random = () => 0, wrapDb = (db) => db } = {}) {
  const factory = new IDBFactory();
  const session = memoryArea();
  const localArea = memoryArea(local);
  const tabs = new Map();
  const served = [];
  const sent = [];
  const dropped = new Set();
  const log = { log() {}, warn() {}, error() {} };
  let nextTabId = 1;
  let worker = null;
  let lastError = null;

  const withError = (message, fn) => {
    lastError = { message };
    try { fn(); } finally { lastError = null; }
  };

  // The worker's view of chrome.
  const workerChrome = {
    storage: { session, local: localArea },
    runtime: { get lastError() { return lastError; }, id: EXT_ID },
    tabs: {
      sendMessage(tabId, message, opts, cb) {
        const tab = tabs.get(tabId);
        setImmediate(() => {
          if (!tab || !tab.listener) return withError('Could not establish connection. Receiving end does not exist.', () => cb());
          let answered = false;
          const respond = (r) => { if (!answered) { answered = true; cb(r); } };
          const held = tab.listener(message, { id: EXT_ID }, respond);
          if (!held && !answered) withError('The message port closed before a response was received.', () => cb());
        });
      },
      async update(tabId, { url }) {
        if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
        setImmediate(() => navigate(tabId, url));
        return { id: tabId };
      },
    },
  };

  function startWorker() {
    const timers = timerSet();
    const engine = createEngine({
      chrome: workerChrome,
      openDb: () => DB.open({ indexedDB: factory }).then(wrapDb),
      now, random, log, flags,
      setTimer: timers.setTimeout,
      clearTimer: timers.clearTimeout,
    });
    const router = createRouter({ extensionId: EXT_ID, log });
    router.on('START_RUN', (m) => engine.start(m));
    router.on('STOP_RUN', () => engine.stop());
    router.on('GET_STATE', () => engine.getState());
    router.on('PAGE_READY', (m, s) => engine.pageReady(m, s));
    router.on('PAGE_RESULT', (m, s) => engine.pageResult(m, s));
    router.on('HEARTBEAT', (m, s) => engine.heartbeat(m, s));
    router.on('GET_RESULTS', () => engine.getResults());
    router.on('SPREAD_RESULT', (m) => engine.spreadResult(m));
    worker = { engine, router, timers };
    return worker;
  }

  /** A content script message to the worker, from tab `tabId`. Starts a stopped worker. */
  function fromTab(tabId, message, cb) {
    sent.push({ tabId, type: message && message.type });
    if (dropped.has(message && message.type)) {
      setImmediate(() => { if (cb) withError('Could not establish connection. Receiving end does not exist.', () => cb()); });
      return;
    }
    setImmediate(() => {
      const w = worker || startWorker();
      let answered = false;
      const respond = (r) => { if (!answered) { answered = true; if (cb) cb(r); } };
      const held = w.router.listener(message, { id: EXT_ID, tab: { id: tabId } }, respond);
      if (!held && !answered && cb) withError('The message port closed before a response was received.', () => cb());
    });
  }

  function tabChrome(tabId) {
    return {
      runtime: {
        id: EXT_ID,
        get lastError() { return lastError; },
        sendMessage(message, cb) { fromTab(tabId, message, cb); },
        onMessage: { addListener(fn) { tabs.get(tabId).listener = fn; } },
        getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      },
    };
  }

  function navigate(tabId, url) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (tab.timers) tab.timers.clearAll();
    tab.listener = null;
    tab.url = url;
    (worker || startWorker()).engine.tabUpdated(tabId, { status: 'loading', url }, { id: tabId, url });
    const html = site(url);
    served.push({ tabId, url });
    if (html == null) return;
    tab.timers = timerSet();
    tab.ctx = loadContentScript('scripts/content/scraper.js', html, url, {
      flags,
      globals: { chrome: tabChrome(tabId), ...tab.timers },
    });
  }

  return {
    served,
    sent,
    session,
    local: localArea,
    get worker() { return worker || startWorker(); },
    engine: () => (worker || startWorker()).engine,
    openTab(url) {
      const id = nextTabId++;
      tabs.set(id, { id });
      navigate(id, url);
      return id;
    },
    closeTab(id) {
      const tab = tabs.get(id);
      if (tab && tab.timers) tab.timers.clearAll();
      tabs.delete(id);
      return (worker || startWorker()).engine.tabRemoved(id);
    },
    goTo(id, url) { navigate(id, url); },
    /** Messages of these types from tabs are lost, as when the worker is not up. */
    drop(...types) { dropped.clear(); types.forEach((t) => dropped.add(t)); },
    tabCtx: (id) => tabs.get(id).ctx,
    /** A popup message to the worker. */
    popup(message) {
      return new Promise((resolve) => {
        const w = worker || startWorker();
        const held = w.router.listener(message, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup/popup.html` }, resolve);
        if (!held) setImmediate(() => resolve(undefined));
      });
    },
    /** Stops the worker the way Chrome does: its timers and memory go, storage stays. */
    killWorker() {
      if (worker) worker.timers.clearAll();
      worker = null;
    },
    run: async () => (await session.get('run')).run || null,
    db: () => DB.open({ indexedDB: factory }),
  };
}

/** Lets messages, IndexedDB and timers settle; with fake timers, moves time on by `ms`. */
async function settle(ms = 0, step = 250) {
  const spin = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(0);
    await spin();
  }
  for (let t = 0; t < ms; t += step) {
    jest.advanceTimersByTime(Math.min(step, ms - t));
    await spin();
  }
}

module.exports = { createRig, settle, memoryArea, EXT_ID };
