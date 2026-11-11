/**
 * The content script's side of a run: it parses and reports, and nothing
 * else. Tab ownership, Stop and the page cap now live in the service
 * worker and are tested in engine.test.js, over this same script.
 */
const fs = require('fs');
const path = require('path');
const { loadContentScript } = require('../setup/dom-helpers');

const html = fs.readFileSync(path.join(__dirname, '../pages/2026-09/search-title-recipe-synthetic.html'), 'utf8');
const URL1 = 'https://www.amazon.com/s?k=widget';

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

let listener;
let sent;
let replies;
const orig = {};

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] });
  orig.add = chrome.runtime.onMessage.addListener;
  orig.send = chrome.runtime.sendMessage;
  orig.id = chrome.runtime.id;
  listener = null;
  sent = [];
  replies = {};
  chrome.runtime.id = 'test-extension';
  chrome.runtime.onMessage.addListener = (fn) => { listener = fn; };
  chrome.runtime.sendMessage = (msg, cb) => {
    sent.push(msg);
    const r = replies[msg.type];
    if (cb) cb(typeof r === 'function' ? r(msg) : r);
  };
  chrome.storage.local._reset();
});

afterEach(() => {
  chrome.runtime.onMessage.addListener = orig.add;
  chrome.runtime.sendMessage = orig.send;
  chrome.runtime.id = orig.id;
  jest.clearAllTimers();
  jest.useRealTimers();
});

const types = () => sent.map((m) => m.type);

test('on load it says PAGE_READY and nothing more when the tab has no run', async () => {
  replies.PAGE_READY = { idle: true };
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  jest.advanceTimersByTime(10000);
  await settle();
  expect(types()).toEqual(['PAGE_READY']);
  expect(sent[0].url).toBe(URL1);
});

test('asked to parse on load, it reports the page and then keeps a heartbeat', async () => {
  replies.PAGE_READY = { parse: true, runId: 'r1', page: 2 };
  replies.PAGE_RESULT = { ok: true, next: 'wait' };
  replies.HEARTBEAT = { active: true };
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  const report = sent.find((m) => m.type === 'PAGE_RESULT');
  expect(report).toMatchObject({ runId: 'r1', page: 2, url: URL1 });
  expect(report.result.kind).toBe('results');
  expect(report.result.products.length).toBeGreaterThan(0);
  jest.advanceTimersByTime(4100);
  await settle();
  expect(types().filter((t) => t === 'HEARTBEAT')).toHaveLength(2);
});

test('the heartbeat stops when the worker says the run is over', async () => {
  replies.PAGE_READY = { parse: true, runId: 'r1', page: 1 };
  replies.PAGE_RESULT = { ok: true, next: 'wait' };
  replies.HEARTBEAT = { active: false };
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(2000);
    await settle();
  }
  expect(types().filter((t) => t === 'HEARTBEAT')).toHaveLength(1);
});

test('the last page stops the heartbeat, and RUN_ENDED does too', async () => {
  replies.PAGE_READY = { parse: true, runId: 'r1', page: 1 };
  replies.PAGE_RESULT = { ok: true, next: 'end' };
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  jest.advanceTimersByTime(6000);
  await settle();
  expect(types()).toEqual(['PAGE_READY', 'PAGE_RESULT']);

  replies.PAGE_RESULT = { ok: true, next: 'wait' };
  listener({ type: 'PARSE_PAGE', runId: 'r2', page: 1 }, {}, () => {});
  jest.advanceTimersByTime(0);
  await settle();
  listener({ type: 'RUN_ENDED', runId: 'r2' }, {}, () => {});
  jest.advanceTimersByTime(6000);
  await settle();
  expect(types().filter((t) => t === 'HEARTBEAT')).toEqual([]);
});

test('a page is reported once per run, however often it is asked', async () => {
  replies.PAGE_READY = { parse: true, runId: 'r1', page: 1 };
  replies.PAGE_RESULT = { ok: true, next: 'wait' };
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  const respond = jest.fn();
  expect(listener({ type: 'PARSE_PAGE', runId: 'r1', page: 1 }, {}, respond)).toBe(false);
  expect(respond).toHaveBeenCalledWith({ ok: true });
  jest.advanceTimersByTime(0);
  await settle();
  expect(types().filter((t) => t === 'PAGE_RESULT')).toHaveLength(1);
});

test('a page whose report never got through is reported again when asked', async () => {
  replies.PAGE_READY = { parse: true, runId: 'r1', page: 1 };
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(1000);
    await settle();
  }
  expect(types().filter((t) => t === 'PAGE_RESULT')).toHaveLength(3);
  replies.PAGE_RESULT = { ok: true, next: 'wait' };
  listener({ type: 'PARSE_PAGE', runId: 'r1', page: 1 }, {}, jest.fn());
  jest.advanceTimersByTime(0);
  await settle();
  expect(types().filter((t) => t === 'PAGE_RESULT')).toHaveLength(4);
});

test('with no answer from a starting worker it tries again', async () => {
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  expect(types()).toEqual(['PAGE_READY']);
  replies.PAGE_READY = { idle: true };
  jest.advanceTimersByTime(1000);
  await settle();
  expect(types()).toEqual(['PAGE_READY', 'PAGE_READY']);
});

test('PARSE_PAGE without a run id is refused', () => {
  loadContentScript('scripts/content/scraper.js', html, URL1);
  const respond = jest.fn();
  listener({ type: 'PARSE_PAGE' }, {}, respond);
  expect(respond).toHaveBeenCalledWith({ ok: false });
});

test('PING answers with the page kind and URL', () => {
  loadContentScript('scripts/content/scraper.js', html, URL1);
  const respond = jest.fn();
  listener({ type: 'PING' }, {}, respond);
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, kind: 'results', url: URL1 }));
});

test('it never writes storage', async () => {
  replies.PAGE_READY = { parse: true, runId: 'r1', page: 1 };
  replies.PAGE_RESULT = { ok: true, next: 'wait' };
  const set = jest.spyOn(chrome.storage.local, 'set');
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  jest.advanceTimersByTime(5000);
  await settle();
  expect(set).not.toHaveBeenCalled();
  set.mockRestore();
});

test('after the extension is updated under the page it goes quiet (alive guard)', async () => {
  replies.PAGE_READY = { parse: true, runId: 'r1', page: 1 };
  replies.PAGE_RESULT = { ok: true, next: 'wait' };
  loadContentScript('scripts/content/scraper.js', html, URL1);
  await settle();
  const before = sent.length;
  chrome.runtime.id = undefined;
  jest.advanceTimersByTime(6000);
  await settle();
  expect(sent.length).toBe(before);
  const respond = jest.fn();
  expect(listener({ type: 'PING' }, {}, respond)).toBe(false);
  expect(respond).not.toHaveBeenCalled();
});
