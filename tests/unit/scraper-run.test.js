/**
 * The scraper's run handling: tab ownership, Stop and the page cap. The
 * Chromium harness in tests/e2e covers the same in a real browser.
 */
const fs = require('fs');
const path = require('path');
const { loadContentScript } = require('../setup/dom-helpers');
const Run = require('../../scripts/lib/run');

const html = fs.readFileSync(path.join(__dirname, '../pages/2026-09/search-title-recipe-synthetic.html'), 'utf8');
const URL1 = 'https://www.amazon.com/s?k=widget';

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

let listener;
let sent;
let tabIdForWorker;
const orig = {};

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] });
  orig.add = chrome.runtime.onMessage.addListener;
  orig.send = chrome.runtime.sendMessage;
  orig.id = chrome.runtime.id;
  listener = null;
  sent = [];
  tabIdForWorker = null;
  chrome.runtime.id = 'test-extension';
  chrome.runtime.onMessage.addListener = (fn) => { listener = fn; };
  chrome.runtime.sendMessage = (msg, cb) => {
    sent.push(msg.type);
    if (msg.type === 'WHO_AM_I' && cb) cb({ tabId: tabIdForWorker });
  };
  chrome.storage.local._reset();
});

afterEach(() => {
  chrome.runtime.onMessage.addListener = orig.add;
  chrome.runtime.sendMessage = orig.send;
  chrome.runtime.id = orig.id;
  chrome.storage.local._reset();
  jest.clearAllTimers();
  jest.useRealTimers();
});

function seedRun(extra = {}) {
  const run = { ...{ ...Run.create({ runId: 'r1', tabId: 5 }), nextHref: URL1 }, ...extra };
  chrome.storage.local.set({ run, scrapeRunId: 'r1', scrapeRunPageIndex: 0, isScrapingActive: true });
  return run;
}

test('a page load in another tab does not join the run', async () => {
  seedRun();
  tabIdForWorker = 9;
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  expect(chrome.storage.local._getStore().results).toBeUndefined();
  expect(sent).toEqual(['WHO_AM_I']);
});

test('a page load in the run tab scrapes and schedules the next page', async () => {
  seedRun();
  tabIdForWorker = 5;
  const ctx = loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  const store = chrome.storage.local._getStore();
  expect(store.results.length).toBeGreaterThan(0);
  expect(store.run).toMatchObject({ status: 'running', page: 1, lastUrl: URL1 });
  expect(ctx.console.log.mock.calls.some((c) => /Navigating to next page/.test(c[0]))).toBe(true);
});

test('Stop cancels the pending page and records the run as stopped', async () => {
  seedRun();
  tabIdForWorker = 5;
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  const respond = jest.fn();
  expect(listener({ type: 'STOP_SCRAPING', runId: 'r1' }, {}, respond)).toBe(true);
  await settle();
  expect(respond).toHaveBeenCalledWith({ stopped: true });
  expect(jest.getTimerCount()).toBe(0);
  expect(chrome.storage.local._getStore().run.status).toBe('stopped');
  expect(chrome.storage.local._getStore().isScrapingActive).toBe(false);
});

test('Stop during a page save still ends the run as stopped', async () => {
  seedRun();
  tabIdForWorker = 5;
  const realSet = chrome.storage.local.set;
  let held = null;
  chrome.storage.local.set = (items, cb) => {
    if (items.results && !held) { held = () => realSet.call(chrome.storage.local, items, cb); return; }
    return realSet.call(chrome.storage.local, items, cb);
  };
  try {
    loadContentScript('scripts/content/scraper.js', html, URL1);
    await settle();
    expect(held).not.toBeNull();
    const respond = jest.fn();
    listener({ type: 'STOP_SCRAPING', runId: 'r1' }, {}, respond);
    await settle();
    held();
    await settle();
  } finally {
    chrome.storage.local.set = realSet;
  }
  expect(chrome.storage.local._getStore().run.status).toBe('stopped');
  expect(jest.getTimerCount()).toBe(0);
});

test('the page cap ends the run on that page', async () => {
  seedRun({ maxPages: 1 });
  tabIdForWorker = 5;
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  const store = chrome.storage.local._getStore();
  expect(store.run.status).toBe('complete');
  expect(store.isScrapingActive).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
});

test('START without a run id is refused', () => {
  loadContentScript('scripts/content/scraper.js', html, URL1);
  const respond = jest.fn();
  listener({ type: 'START_SCRAPING' }, {}, respond);
  expect(respond).toHaveBeenCalledWith({ status: 'refused' });
});

test('PING answers with the page kind', () => {
  loadContentScript('scripts/content/scraper.js', html, URL1);
  const respond = jest.fn();
  listener({ type: 'PING' }, {}, respond);
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, kind: 'results' }));
});

test('a different search typed in the run tab ends the run instead of joining it', async () => {
  seedRun({ page: 1, lastUrl: URL1, nextHref: 'https://www.amazon.com/s?k=widget&page=2&ref=sr_pg_1' });
  tabIdForWorker = 5;
  loadContentScript('scripts/content/scraper.js', html, 'https://www.amazon.com/s?k=garden+hose');
  await settle();
  const store = chrome.storage.local._getStore();
  expect(store.results).toBeUndefined();
  expect(store.run.status).toBe('interrupted');
  expect(store.isScrapingActive).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
});

test('a stale run is ended, not resumed, when its tab loads Amazon again', async () => {
  seedRun({ heartbeat: Date.now() - Run.STALE_MS - 1000 });
  tabIdForWorker = 5;
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  const store = chrome.storage.local._getStore();
  expect(store.results).toBeUndefined();
  expect(store.run.status).toBe('interrupted');
  expect(jest.getTimerCount()).toBe(0);
});
