const Msg = require('../../scripts/lib/messages');
const { createRouter } = require('../../scripts/background/router');

const quiet = { warn() {}, error() {} };
const TAB = { id: 'ext', tab: { id: 4 } };
const PAGE = { id: 'ext', url: 'chrome-extension://ext/popup/popup.html' };

function call(router, message, sender) {
  return new Promise((resolve) => {
    const held = router.listener(message, sender, resolve);
    if (!held) setTimeout(() => resolve('no answer'), 0);
  });
}

test('every worker message in the catalog says who may send it', () => {
  for (const [type, entry] of Object.entries(Msg.CATALOG)) {
    expect(Msg.T[type]).toBe(type);
    if (entry.to === 'worker') expect(['tab', 'page', 'any']).toContain(entry.from);
  }
});

test('a handler answers with its value, sync or async', async () => {
  const r = createRouter({ extensionId: 'ext', log: quiet });
  r.on('GET_STATE', () => ({ run: null }));
  r.on('HEARTBEAT', async () => ({ active: true }));
  expect(await call(r, { type: 'GET_STATE' }, PAGE)).toEqual({ run: null });
  expect(await call(r, { type: 'HEARTBEAT' }, TAB)).toEqual({ active: true });
});

test('a throwing or rejecting handler answers with an error', async () => {
  const r = createRouter({ extensionId: 'ext', log: quiet });
  r.on('STOP_RUN', () => { throw new Error('boom'); });
  r.on('START_RUN', async () => { throw new Error('later'); });
  expect(await call(r, { type: 'STOP_RUN' }, PAGE)).toEqual({ error: 'boom' });
  expect(await call(r, { type: 'START_RUN' }, PAGE)).toEqual({ error: 'later' });
});

test('page-only messages are refused from a tab, and tab-only ones from a page', async () => {
  const r = createRouter({ extensionId: 'ext', log: quiet });
  const start = jest.fn(() => ({ ok: true }));
  const result = jest.fn(() => ({ ok: true }));
  r.on('START_RUN', start);
  r.on('PAGE_RESULT', result);
  expect(await call(r, { type: 'START_RUN' }, TAB)).toBe('no answer');
  expect(await call(r, { type: 'PAGE_RESULT' }, PAGE)).toBe('no answer');
  expect(start).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
});

test('another extension is refused', async () => {
  const r = createRouter({ extensionId: 'ext', log: quiet });
  const h = jest.fn();
  r.on('GET_RESULTS', h);
  expect(await call(r, { type: 'GET_RESULTS' }, { id: 'other', tab: { id: 1 } })).toBe('no answer');
  expect(h).not.toHaveBeenCalled();
});

test('unknown, malformed and popup-bound messages do not hold the channel', () => {
  const r = createRouter({ extensionId: 'ext', log: quiet });
  const respond = jest.fn();
  for (const m of [null, 'PING', {}, { type: 'NOPE' }, { type: 'SPREAD_PROGRESS' }, { type: 'PING' }]) {
    expect(r.listener(m, TAB, respond)).toBe(false);
  }
  expect(respond).not.toHaveBeenCalled();
});

test('only worker messages can be registered, once each', () => {
  const r = createRouter({ log: quiet });
  expect(() => r.on('PING', () => {})).toThrow(/not a worker message/);
  expect(() => r.on('MADE_UP', () => {})).toThrow(/not a worker message/);
  r.on('GET_STATE', () => {});
  expect(() => r.on('GET_STATE', () => {})).toThrow(/already/);
});

test('the popup open in a tab is still a page, not a content script', async () => {
  const r = createRouter({ extensionId: 'ext', log: quiet });
  r.on('START_RUN', () => ({ ok: true }));
  r.on('PAGE_READY', () => ({ idle: true }));
  const popupTab = { id: 'ext', tab: { id: 9 }, url: 'chrome-extension://ext/popup/popup.html' };
  expect(await call(r, { type: 'START_RUN' }, popupTab)).toEqual({ ok: true });
  expect(await call(r, { type: 'PAGE_READY' }, popupTab)).toBe('no answer');
  expect(await call(r, { type: 'PAGE_READY' }, { id: 'ext', tab: { id: 9 }, url: 'https://www.amazon.com/s?k=a' })).toEqual({ idle: true });
});

test('the dock messages come from a tab only, never from a page or another extension', async () => {
  const r = createRouter({ extensionId: 'ext', log: quiet });
  const types = ['START_RUN_HERE', 'STOP_RUN_HERE', 'RUN_STATUS', 'SAVE_SETTINGS', 'DOWNLOAD', 'OPEN_SETTINGS'];
  const h = jest.fn(() => ({ ok: true }));
  types.forEach((t) => r.on(t, h));
  for (const t of types) {
    expect(await call(r, { type: t }, PAGE)).toBe('no answer');
    expect(await call(r, { type: t }, { id: 'other', tab: { id: 1 } })).toBe('no answer');
    expect(await call(r, { type: t }, TAB)).toEqual({ ok: true });
  }
  expect(h).toHaveBeenCalledTimes(types.length);
});
