/**
 * @jest-environment node
 *
 * The on-page dock (scripts/content/dock.js) in a JSDOM page per test.
 * Its shadow root is forced open here so the test can look inside.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = [
  'scripts/modules/price.js', 'scripts/lib/parsers.js', 'scripts/lib/run.js', 'scripts/lib/page-kind.js',
  'scripts/content/dock-styles.js', 'scripts/content/dock.js',
].map(read).join('\n;\n');
const YOGA = read('tests/pages/2026-09/search-yoga-mat.html');
const PRODUCT = read('tests/pages/2026-09/product-dp.html');

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const IDLE = { run: null, count: 0, settings: { maxPages: 20, suggest: true }, hasKey: false, signedIn: false, cloudSync: true };

function mount(url, html, replies = {}, { session = {} } = {}) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window;
  windows.push(w);
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  Object.entries(session).forEach(([k, v]) => w.sessionStorage.setItem(k, v));
  const out = { w, sent: [], listeners: [], shadow: null, spread: [] };
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function () { out.shadow = attach.call(this, { mode: 'open' }); return out.shadow; };
  w.chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      getManifest: () => ({ version: '2.4.0' }),
      sendMessage(msg, cb) {
        out.sent.push(msg);
        const r = replies[msg.type];
        Promise.resolve(typeof r === 'function' ? r(msg) : r).then((v) => setImmediate(() => cb(v)));
      },
      onMessage: { addListener: (fn) => out.listeners.push(fn) },
    },
  };
  w.watchSpread = (fn) => { out.spread.push(fn); return () => {}; };
  w.runSpreadAnalysis = jest.fn();
  w.stopSpreadAnalysis = jest.fn();
  w.eval(SRC);
  out.$ = (sel) => out.shadow && out.shadow.querySelector(sel);
  out.$$ = (sel) => (out.shadow ? [...out.shadow.querySelectorAll(sel)] : []);
  out.text = () => (out.shadow ? out.shadow.textContent.replace(/\s+/g, ' ') : '');
  out.types = () => out.sent.map((m) => m.type);
  return out;
}

const SEARCH = 'https://www.amazon.com/s?k=yoga+mat';

const windows = [];
afterEach(() => { windows.splice(0).forEach((w) => w.close()); });

test('a search page suggests Scrape, and one click starts a run in this tab', async () => {
  let started = false;
  const d = mount(SEARCH, YOGA, {
    RUN_STATUS: () => (started
      ? { ...IDLE, run: { state: 'running', page: 0, maxPages: 20, itemCount: 0, thisTab: true, source: { type: 'keyword', keyword: 'yoga mat' } } }
      : IDLE),
    START_RUN_HERE: () => { started = true; return { ok: true, runId: 'r1' }; },
  });
  await flush();
  expect(d.$('.launcher.suggest')).not.toBeNull();
  expect(d.text()).toContain('"yoga mat"');
  expect(d.$('.launch-text span').textContent).toMatch(/^\d+ products$/);

  d.$('[data-k="scrape-quick"]').click();
  await flush();
  const start = d.sent.find((m) => m.type === 'START_RUN_HERE');
  expect(start).toBeDefined();
  expect(start).not.toHaveProperty('tabId');
  expect(d.$('.card')).not.toBeNull();
  expect(d.$('.num').textContent).toBe('0 products');
  expect(d.text()).toContain('Page 1 of 20');
  expect(d.$('[data-k="stop"]').getAttribute('aria-label')).toBe('Stop and keep 0 products');
});

test('a product page gets the plain launcher with Ask and no Scrape', async () => {
  const d = mount('https://www.amazon.com/dp/B09B8V1LZ3', PRODUCT, { RUN_STATUS: IDLE });
  await flush();
  expect(d.$('.launcher.plain')).not.toBeNull();
  expect(d.$('[data-k="scrape-quick"]')).toBeNull();
  expect(d.$('[data-k="chat"]').getAttribute('aria-label')).toBe('Ask about products');
  d.$('[data-k="launcher"]').click();
  await flush();
  expect(d.text()).toContain('Open a search or a storefront');
  expect(d.$('[data-k="scrape"]')).toBeNull();
  expect(d.types()).not.toContain('START_RUN_HERE');
});

test('cart, checkout and sign-in pages get no dock at all', async () => {
  for (const url of ['https://www.amazon.com/gp/cart/view.html', 'https://www.amazon.com/checkout/p/p-1/spc', 'https://www.amazon.com/ap/signin']) {
    const d = mount(url, '<html><body></body></html>', { RUN_STATUS: IDLE });
    await flush();
    expect(d.w.document.getElementById('proscan-dock-host')).toBeNull();
    expect(d.sent).toEqual([]);
  }
});

test('Not now hides the suggestion for the rest of the tab session', async () => {
  const d = mount(SEARCH, YOGA, { RUN_STATUS: IDLE });
  await flush();
  d.$('[data-k="notnow"]').click();
  await flush();
  expect(d.w.sessionStorage.getItem('proscan.dock.notNow')).toBe('1');
  expect(d.$('.launcher.plain')).not.toBeNull();

  const again = mount(SEARCH, YOGA, { RUN_STATUS: IDLE }, { session: { 'proscan.dock.notNow': '1' } });
  await flush();
  expect(again.$('.launcher.plain')).not.toBeNull();
  expect(again.$('[data-k="scrape-quick"]')).toBeNull();
});

test('the Suggest Scrape setting turned off keeps the launcher plain', async () => {
  const d = mount(SEARCH, YOGA, { RUN_STATUS: { ...IDLE, settings: { maxPages: 20, suggest: false } } });
  await flush();
  expect(d.$('.launcher.plain')).not.toBeNull();
});

test('a seller profile points at its storefront and never starts a run there', async () => {
  const d = mount('https://www.amazon.com/sp?seller=A1B2C3D4E5F6G7', '<html><body><h1 id="seller-name">Northfield Goods</h1></body></html>', { RUN_STATUS: IDLE });
  await flush();
  const link = d.$('[data-k="storefront"]');
  expect(link.getAttribute('href')).toBe('https://www.amazon.com/s?me=A1B2C3D4E5F6G7&marketplaceID=ATVPDKIKX0DER');
  expect(d.text()).toContain('Northfield Goods');
});

test('a running run minimizes to page x of y with a labeled Stop', async () => {
  const running = { ...IDLE, run: { state: 'running', page: 3, maxPages: 10, itemCount: 181, thisTab: true, startedAt: Date.now() - 30000, source: { type: 'storefront', sellerId: 'A1B2C3D4E5F6G7' } } };
  const d = mount(SEARCH, YOGA, { RUN_STATUS: running, STOP_RUN_HERE: { ok: true, stopped: true } });
  await flush();
  expect(d.text()).toContain('Page 4 of 10');
  expect(d.text()).toContain('181 products so far');
  const stop = d.$('[data-k="stop"]');
  expect(stop.textContent).toContain('Stop');
  expect(stop.getAttribute('aria-label')).toBe('Stop scraping and keep 181 products');
  stop.click();
  await flush();
  expect(d.types()).toContain('STOP_RUN_HERE');
});

test('the worker saying a page was saved refreshes the dock', async () => {
  let page = 1;
  const d = mount(SEARCH, YOGA, {
    RUN_STATUS: () => ({ ...IDLE, run: { state: 'running', page, maxPages: 5, itemCount: page * 48, thisTab: true, source: { type: 'keyword', keyword: 'yoga mat' } } }),
  });
  await flush();
  expect(d.text()).toContain('Page 2 of 5');
  page = 2;
  d.listeners.forEach((fn) => fn({ type: 'RUN_PROGRESS', page: 2 }));
  await flush();
  expect(d.text()).toContain('Page 3 of 5');
  expect(d.text()).toContain('96 products so far');
});

test('a run that ran out of pages hatches the rest and says so', async () => {
  const done = {
    ...IDLE, count: 912,
    run: { state: 'done', reason: 'complete', page: 19, maxPages: 20, itemCount: 912, thisTab: true, finishedAt: Date.now(), source: { type: 'keyword', keyword: 'yoga mat' } },
    summary: { medianCents: 2740, avgRating: 4.5, sponsoredPct: 12 }, spreadCount: 0,
  };
  const d = mount(SEARCH, YOGA, { RUN_STATUS: done, DOWNLOAD: { ok: true, via: 'downloads', filename: 'x.xlsx' } }, { session: { 'proscan.dock.open': '1' } });
  await flush();
  expect(d.$('.num').textContent).toBe('912 products');
  expect(d.$$('.ticks i')).toHaveLength(20);
  expect(d.$$('.ticks i.done')).toHaveLength(19);
  expect(d.text()).not.toContain('$27.40');
  expect(d.$('[data-k="csv"]')).toBeNull();
  d.$('[data-k="xlsx"]').click();
  await flush();
  expect(d.sent.find((m) => m.type === 'DOWNLOAD')).toEqual({ type: 'DOWNLOAD', format: 'xlsx' });
  expect(d.$('.toast').textContent).toBe('Excel downloaded');
  expect(d.$('.card .notice')).toBeNull();
});

test('a file too big for the worker to hand over is saved from the page', async () => {
  const done = { ...IDLE, count: 2, run: { state: 'stopped', reason: 'stopped', page: 1, maxPages: 20, itemCount: 2, thisTab: true, finishedAt: Date.now(), source: {} }, summary: null };
  const d = mount(SEARCH, YOGA, {
    RUN_STATUS: done,
    DOWNLOAD: { ok: true, via: 'page', filename: 'big.csv', mime: 'text/csv', base64: Buffer.from('a,b\r\n').toString('base64') },
  }, { session: { 'proscan.dock.open': '1' } });
  d.w.URL.createObjectURL = jest.fn(() => 'blob:x');
  d.w.URL.revokeObjectURL = jest.fn();
  const clicks = [];
  d.w.HTMLAnchorElement.prototype.click = function () { clicks.push([this.getAttribute('download'), this.href]); };
  await flush();
  expect(d.$('.num').textContent).toBe('2 products');
  expect(d.$('.meta').textContent).toBe('Stopped');
  d.$('[data-k="formats"]').click();
  expect(d.$('[data-k="formats"]').getAttribute('aria-expanded')).toBe('true');
  d.$('[data-k="csv"]').click();
  await flush();
  expect(clicks).toEqual([['big.csv', 'blob:x']]);
});

test('Ask with no key sends the user to ProScan settings, never asks for the key here', async () => {
  const d = mount(SEARCH, YOGA, {
    RUN_STATUS: IDLE, CHAT_STATUS: { hasKey: false, productCount: 12, source: 'search "yoga mat"' }, OPEN_SETTINGS: { ok: true },
  });
  await flush();
  d.$('[data-k="chat"]').click();
  await flush();
  expect(d.$('.scope').textContent).toBe('12 products');
  expect(d.$$('input[type="password"]')).toEqual([]);
  d.$('[data-k="add-key"]').click();
  await flush();
  expect(d.sent.find((m) => m.type === 'OPEN_SETTINGS')).toEqual({ type: 'OPEN_SETTINGS', section: 'key' });
});

test('chat answers are text, and only the question and history go out', async () => {
  const evil = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
  const d = mount(SEARCH, YOGA, {
    RUN_STATUS: IDLE, CHAT_STATUS: { hasKey: true, productCount: 3, source: 'search "yoga mat"' }, CHAT_MESSAGE: { answer: evil },
  });
  await flush();
  d.$('[data-k="chat"]').click();
  await flush();
  const input = d.$('[data-k="compose"]');
  input.value = 'cheapest?';
  input.dispatchEvent(new d.w.Event('input'));
  d.$('[data-k="send"]').click();
  await flush();
  const msgs = d.$$('.msg');
  expect(msgs[msgs.length - 1].textContent).toBe(evil);
  expect(d.$('.msg img')).toBeNull();
  const chat = d.sent.find((m) => m.type === 'CHAT_MESSAGE');
  expect(Object.keys(chat).sort()).toEqual(['history', 'question', 'type']);
});

test('every icon-only control has a label, and Escape closes the card', async () => {
  const d = mount(SEARCH, YOGA, { RUN_STATUS: IDLE });
  await flush();
  const unlabeled = () => d.$$('button, a').filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby'));
  expect(unlabeled()).toEqual([]);
  d.$('[data-k="launcher"]').click();
  await flush();
  expect(unlabeled()).toEqual([]);
  d.$('[data-k="gear"]').click();
  await flush();
  expect(unlabeled()).toEqual([]);
  expect(d.text()).toContain('Scans stay on this computer unless you sign in.');
  expect(d.$$('input[type="password"], input[type="email"]')).toEqual([]);

  d.$('.dock').dispatchEvent(new d.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  expect(d.$('.card')).toBeNull();
  expect(d.shadow.activeElement.getAttribute('data-k')).toBe('launcher');
});

test('keys typed in the dock do not reach the page', async () => {
  const d = mount(SEARCH, YOGA, { RUN_STATUS: IDLE, CHAT_STATUS: { hasKey: true, productCount: 3 } });
  const seen = [];
  d.w.document.addEventListener('keydown', (e) => seen.push(e.key));
  await flush();
  d.$('[data-k="chat"]').click();
  await flush();
  d.$('[data-k="compose"]').dispatchEvent(new d.w.KeyboardEvent('keydown', { key: '/', bubbles: true, composed: true }));
  expect(seen).toEqual([]);
});
