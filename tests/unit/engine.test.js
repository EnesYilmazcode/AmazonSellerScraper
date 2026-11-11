/**
 * @jest-environment node
 *
 * The service worker run engine with the real scraper.js in each tab
 * (tests/setup/engine-rig.js). The Chromium harness in tests/e2e runs the
 * same scenarios in a real browser.
 */
const fs = require('fs');
const path = require('path');
const { createRig, settle } = require('../setup/engine-rig');
const { foldPage } = require('../../scripts/background/engine');
const Run = require('../../scripts/lib/run');

const CAPTCHA = fs.readFileSync(path.join(__dirname, '../pages/2026-09/captcha-synthetic.html'), 'utf8');
const PRODUCT = fs.readFileSync(path.join(__dirname, '../pages/2026-09/product-dp.html'), 'utf8');

const asinFor = (k, page, i) => `B0${k.slice(0, 3).toUpperCase().padEnd(3, 'X')}${String(page).padStart(2, '0')}${String(i).padStart(3, '0')}`;
const card = (asin, price, { ad = false, rating = true } = {}) => `
  <div class="s-result-item${ad ? ' AdHolder' : ''}" data-asin="${asin}" data-component-type="s-search-result">
    <a href="/dp/${asin}"><h2><span>Item ${asin}</span></h2></a>
    <div class="a-price" data-a-size="xl"><span class="a-offscreen">${price}</span></div>
    ${rating ? '<div data-cy="reviews-ratings-slot"><span class="a-icon-alt">4.5 out of 5 stars</span></div><a aria-label="1,000 ratings" href="#r">(1K)</a>' : ''}
  </div>`;
const page = (cards, next) => `<!DOCTYPE html><html><body><div class="s-main-slot">${cards}</div>${
  next ? `<a class="s-pagination-next" href="${next}">Next</a>` : '<span class="s-pagination-next s-pagination-disabled">Next</span>'
}</body></html>`;
const searchUrl = (k, p = 1) => `https://www.amazon.com/s?k=${k}${p > 1 ? `&page=${p}` : ''}`;
const pageNo = (url) => Number(new URL(url).searchParams.get('page') || 1);

/** A site of `pages` generated search pages per keyword. */
function simpleSite(pages, { captchaAt = null } = {}) {
  return (url) => {
    const u = new URL(url);
    if (u.hostname !== 'www.amazon.com') return null;
    if (u.pathname.startsWith('/dp/')) return PRODUCT;
    const k = u.searchParams.get('k');
    const p = pageNo(url);
    if (p === captchaAt) return CAPTCHA;
    if (p > pages) return null;
    const cards = [0, 1, 2, 3].map((i) => card(asinFor(k, p, i), `$${10 + i}.0${p}`)).join('');
    return page(cards, p < pages ? `/s?k=${k}&page=${p + 1}` : null);
  };
}

const served = (rig, k) => rig.served.filter((s) => s.url.includes(`k=${k}`)).map((s) => pageNo(s.url));

async function results(rig) {
  return (await rig.popup({ type: 'GET_STATE' })).results;
}

/** Opens a search tab and starts a run in it. */
async function startIn(rig, k) {
  const tab = rig.openTab(searchUrl(k));
  await settle();
  const resp = await rig.popup({ type: 'START_RUN', tabId: tab });
  return { tab, resp };
}

/** Moves time on until the run ends or `ms` passes. */
async function runUntilEnd(rig, ms = 30000) {
  for (let t = 0; t < ms; t += 500) {
    const run = await rig.run();
    if (run && !Run.isActive(run)) return run;
    await settle(500);
  }
  return rig.run();
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a run', () => {
  test('a clean 3 page run scrapes every page once and completes', async () => {
    const rig = createRig({ site: simpleSite(3) });
    const { resp } = await startIn(rig, 'hose');
    expect(resp).toMatchObject({ ok: true });
    const run = await runUntilEnd(rig);
    expect(served(rig, 'hose')).toEqual([1, 2, 3]);
    expect(run).toMatchObject({ state: 'done', reason: 'complete', page: 3, itemCount: 12 });
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.results.map((r) => r.asin)).toEqual([1, 2, 3].flatMap((p) => [0, 1, 2, 3].map((i) => asinFor('hose', p, i))));
    expect(st.results[0]).toMatchObject({ priceCents: 1001, rating: 4.5, reviewCount: 1000, runId: run.runId, pageIndex: 1 });
    expect(st.pages.map((p) => [p.pageIndex, p.count, p.kind])).toEqual([[1, 4, 'results'], [2, 4, 'results'], [3, 4, 'last']]);
    expect(st.run.source).toMatchObject({ type: 'keyword', keyword: 'hose' });
  });

  test('waits 2 to 4 seconds between pages', async () => {
    const rig = createRig({ site: simpleSite(3), random: () => 0.5 });
    await startIn(rig, 'wait');
    await settle(2500);
    expect(served(rig, 'wait')).toEqual([1]);
    await settle(1000);
    expect(served(rig, 'wait')).toEqual([1, 2]);
  });

  test('a captcha at page 2 ends the run as blocked', async () => {
    const rig = createRig({ site: simpleSite(4, { captchaAt: 2 }) });
    await startIn(rig, 'usb');
    const run = await runUntilEnd(rig);
    await settle(5000);

    expect(served(rig, 'usb')).toEqual([1, 2]);
    expect(run).toMatchObject({ state: 'blocked', reason: 'blocked' });
    expect((await results(rig)).map((r) => r.asin)).toEqual([0, 1, 2, 3].map((i) => asinFor('usb', 1, i)));
  });

  test('the page cap in settings ends the run on that page', async () => {
    const rig = createRig({ site: simpleSite(5), local: { settings: { maxPages: 2 } } });
    await startIn(rig, 'cap');
    const run = await runUntilEnd(rig);
    await settle(5000);
    expect(served(rig, 'cap')).toEqual([1, 2]);
    expect(run).toMatchObject({ state: 'done', reason: 'complete', maxPages: 2 });
  });

  test('a page whose cards all fail to parse ends the run as selectors_broken', async () => {
    const broken = '<div class="s-main-slot"><div class="s-result-item" data-asin="B0BROKEN01" data-component-type="s-search-result"></div></div>';
    const rig = createRig({ site: (url) => (pageNo(url) === 1 ? simpleSite(3)(url) : page(broken, null)) });
    await startIn(rig, 'broke');
    const run = await runUntilEnd(rig);
    expect(run).toMatchObject({ state: 'failed', reason: 'selectors_broken', page: 1 });
  });
});

describe('Stop', () => {
  test('Stop halts the run before the next page loads', async () => {
    const rig = createRig({ site: simpleSite(4) });
    await startIn(rig, 'stop');
    await settle();
    expect((await rig.run()).page).toBe(1);
    expect(await rig.popup({ type: 'STOP_RUN' })).toEqual({ ok: true, stopped: true });
    await settle(8000);

    expect(served(rig, 'stop')).toEqual([1]);
    expect(await rig.run()).toMatchObject({ state: 'stopped', reason: 'stopped' });
    expect((await results(rig))).toHaveLength(4);
  });

  test('Stop that lands while a page is being saved still ends the run as stopped', async () => {
    const rig = createRig({ site: simpleSite(4) });
    const tab = rig.openTab(searchUrl('race'));
    await settle();
    await rig.popup({ type: 'START_RUN', tabId: tab });
    // The page result is on its way; Stop queues behind its save.
    const stopped = rig.popup({ type: 'STOP_RUN' });
    await settle();
    await stopped;
    await settle(8000);
    const run = await rig.run();
    expect(run).toMatchObject({ state: 'stopped' });
    expect(served(rig, 'race')).toEqual([1]);
  });

  test('Stop with no run changes nothing', async () => {
    const rig = createRig({ site: simpleSite(1) });
    expect(await rig.popup({ type: 'STOP_RUN' })).toEqual({ ok: true, stopped: false });
    expect(await rig.run()).toBeNull();
  });
});

describe('the run belongs to its tab', () => {
  test('a second search tab opened mid-run does not join the run', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'alpha');
    await settle();
    const other = rig.openTab(searchUrl('beta'));
    const run = await runUntilEnd(rig);

    expect(served(rig, 'beta')).toEqual([1]);
    expect(run).toMatchObject({ reason: 'complete' });
    const got = await results(rig);
    expect(got.filter((r) => r.asin.startsWith('B0BET'))).toEqual([]);
    expect(got).toHaveLength(12);
    expect(other).not.toBe(run.tabId);
  });

  test('a product page opened in another tab does not end the run', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'gamma');
    await settle();
    rig.openTab('https://www.amazon.com/dp/B09B8V1LZ3');
    const run = await runUntilEnd(rig);
    expect(run).toMatchObject({ reason: 'complete', page: 3 });
  });

  test('closing the run tab ends the run as interrupted', async () => {
    const rig = createRig({ site: simpleSite(4) });
    const { tab } = await startIn(rig, 'close');
    await settle();
    await rig.closeTab(tab);
    await settle(8000);
    expect(await rig.run()).toMatchObject({ state: 'failed', reason: 'interrupted' });
    expect(served(rig, 'close')).toEqual([1]);
  });

  test('taking the run tab elsewhere ends the run, and the tab is not pulled back', async () => {
    const rig = createRig({ site: simpleSite(4) });
    const { tab } = await startIn(rig, 'left');
    await settle();
    rig.goTo(tab, 'https://www.amazon.com/dp/B09B8V1LZ3');
    await settle(8000);
    expect(await rig.run()).toMatchObject({ reason: 'interrupted' });
    expect(served(rig, 'left')).toEqual([1]);
  });

  test('a reload of the run tab between pages does not end the run', async () => {
    const rig = createRig({ site: simpleSite(3) });
    const { tab } = await startIn(rig, 'reload');
    await settle();
    rig.goTo(tab, searchUrl('reload'));
    const run = await runUntilEnd(rig);
    expect(run).toMatchObject({ reason: 'complete', page: 3 });
    expect(served(rig, 'reload')).toEqual([1, 1, 2, 3]);
  });
});

describe('starting', () => {
  test('Start on a captcha page changes nothing and says why', async () => {
    const rig = createRig({ site: () => CAPTCHA });
    const tab = rig.openTab(searchUrl('robot'));
    await settle();
    const resp = await rig.popup({ type: 'START_RUN', tabId: tab });
    expect(resp).toMatchObject({ error: 'refused', kind: 'captcha' });
    expect(resp.message).toMatch(/captcha/);
    expect(await rig.run()).toBeNull();
  });

  test('Start on a tab with no content script asks for a reload', async () => {
    const rig = createRig({ site: simpleSite(1) });
    expect(await rig.popup({ type: 'START_RUN', tabId: 99 })).toEqual({ error: 'no_receiver' });
    expect(await rig.run()).toBeNull();
  });

  test('a second Start while a run is going is refused', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'one');
    const tab2 = rig.openTab(searchUrl('two'));
    await settle();
    expect(await rig.popup({ type: 'START_RUN', tabId: tab2 })).toMatchObject({ error: 'busy' });
  });

  test('START_RUN from a content script is refused', async () => {
    const rig = createRig({ site: simpleSite(1) });
    const respond = jest.fn();
    expect(rig.worker.router.listener({ type: 'START_RUN', tabId: 1 }, { id: 'test-extension', tab: { id: 1 } }, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('the worker stopped between pages', () => {
  test('the heartbeat wakes it and the run resumes from session storage', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'sleepy');
    await settle();
    expect((await rig.run()).page).toBe(1);
    rig.killWorker();
    const run = await runUntilEnd(rig);
    expect(served(rig, 'sleepy')).toEqual([1, 2, 3]);
    expect(run).toMatchObject({ reason: 'complete', itemCount: 12 });
  });

  test('killed on every page, the run still finishes once each', async () => {
    const rig = createRig({ site: simpleSite(4) });
    await startIn(rig, 'again');
    for (let i = 0; i < 12; i++) {
      await settle(500);
      rig.killWorker();
    }
    const run = await runUntilEnd(rig);
    expect(served(rig, 'again')).toEqual([1, 2, 3, 4]);
    expect(run).toMatchObject({ reason: 'complete', page: 4 });
    expect(await results(rig)).toHaveLength(16);
  });

  test('a run whose tab stopped checking in ends as interrupted on the next wake', async () => {
    let clock = Date.parse('2026-09-24T10:00:00Z');
    const rig = createRig({ site: simpleSite(3), now: () => clock });
    await startIn(rig, 'stale');
    await settle();
    expect(await rig.run()).toMatchObject({ state: 'running', page: 1 });
    // No heartbeat for longer than STALE_MS: time moves, the page's timers do not.
    clock += Run.STALE_MS + 1;
    rig.killWorker();
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.run).toMatchObject({ state: 'failed', reason: 'interrupted' });
  });

  test('after an update empties session storage, the live run is ended as updated', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'upd');
    await settle();
    await rig.session.remove('run');
    rig.killWorker();
    await rig.engine().recover('updated');
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.run).toMatchObject({ state: 'failed', reason: 'updated' });
  });

  test('after a browser restart a run IndexedDB still has as live is ended', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'restart');
    await settle();
    await rig.session.remove('run');
    rig.killWorker();
    await rig.engine().recover();
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.run).toMatchObject({ state: 'failed', reason: 'interrupted' });
    expect(st.results).toHaveLength(4);
  });

  test('a run ended after a restart queues its final header for the signed-in account', async () => {
    const rig = createRig({ site: simpleSite(3), flags: { CLOUD_SYNC: true }, local: { account: { uid: 'u1' } } });
    await startIn(rig, 'restart');
    await settle();
    await rig.session.remove('run');
    rig.killWorker();
    await rig.engine().recover();
    const db = await rig.db();
    expect((await db.getAll('outbox')).map((e) => e.kind)).toEqual(['page', 'run']);
    db.close();
  });
});

describe('a page that never reports', () => {
  test('is asked again after the page timeout, and the run goes on', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'lost');
    await settle();
    rig.drop('PAGE_READY');
    await settle(4000);
    expect(served(rig, 'lost')).toEqual([1, 2]);
    expect((await rig.run()).page).toBe(1);
    rig.drop();
    const run = await runUntilEnd(rig, 60000);
    expect(run).toMatchObject({ reason: 'complete', page: 3 });
  });
});

describe('a page that never reports, continued', () => {
  test('when the tab is no longer on Amazon, the run ends as interrupted', async () => {
    const site = simpleSite(3);
    const rig = createRig({ site: (url) => (pageNo(url) === 2 ? null : site(url)) });
    await startIn(rig, 'away');
    await settle(4000);
    expect(served(rig, 'away')).toEqual([1, 2]);
    rig.goTo((await rig.run()).tabId, 'https://example.com/');
    const run = await runUntilEnd(rig, 60000);
    expect(run).toMatchObject({ reason: 'interrupted', page: 1 });
  });

  test('a slow page still on Amazon is waited for', async () => {
    const site = simpleSite(3);
    let slow = true;
    const rig = createRig({ site: (url) => (pageNo(url) === 2 && slow ? null : site(url)) });
    const { tab } = await startIn(rig, 'slowly');
    await settle(4000);
    await settle(25000);
    expect(await rig.run()).toMatchObject({ state: 'running', awaiting: true });
    slow = false;
    rig.goTo(tab, searchUrl('slowly', 2));
    const run = await runUntilEnd(rig);
    expect(run).toMatchObject({ reason: 'complete', page: 3 });
  });
});

describe('page results', () => {
  test('a repeated or out of order PAGE_RESULT is ignored', async () => {
    const rig = createRig({ site: simpleSite(3) });
    const { tab } = await startIn(rig, 'latch');
    await settle();
    const run = await rig.run();
    const send = (msg) => new Promise((r) => rig.worker.router.listener(msg, { id: 'test-extension', tab: { id: tab } }, r));
    const result = { kind: 'results', products: [{ asin: 'B0XXXXXXX1', placements: [] }], placements: 1, nextHref: 'x', fill: { title: 1, price: 1 } };
    expect(await send({ type: 'PAGE_RESULT', runId: run.runId, page: 1, url: 'u', result })).toMatchObject({ ignored: true });
    expect(await send({ type: 'PAGE_RESULT', runId: run.runId, page: 5, url: 'u', result })).toMatchObject({ ignored: true });
    expect(await send({ type: 'PAGE_RESULT', runId: 'other', page: 2, url: 'u', result })).toMatchObject({ ignored: true });
    expect(await results(rig)).toHaveLength(4);
  });

  test('PAGE_RESULT from another tab is ignored', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'owner');
    await settle();
    const run = await rig.run();
    const resp = await new Promise((r) => rig.worker.router.listener(
      { type: 'PAGE_RESULT', runId: run.runId, page: 2, url: 'u', result: { kind: 'results', products: [] } },
      { id: 'test-extension', tab: { id: run.tabId + 1 } }, r));
    expect(resp).toMatchObject({ ignored: true });
  });

  test('a page that cannot be saved ends the run loudly as storage_full', async () => {
    let writes = 0;
    const wrapDb = (db) => ({
      ...db,
      write: (ops) => {
        if (ops.some((o) => o.store === 'placements') && ++writes === 2) {
          return Promise.reject(Object.assign(new Error('QuotaExceededError'), { name: 'StorageError', code: 'storage_full' }));
        }
        return db.write(ops);
      },
    });
    const rig = createRig({ site: simpleSite(4), wrapDb });
    await startIn(rig, 'full');
    const run = await runUntilEnd(rig);
    await settle(5000);
    expect(run).toMatchObject({ state: 'failed', reason: 'storage_full', page: 1 });
    expect(served(rig, 'full')).toEqual([1, 2]);
    expect(Run.describe(run, 4).text).toMatch(/storage is full/);
  });
});

describe('the database', () => {
  test('closed under the worker between pages, it is opened again and the run goes on', async () => {
    let opened = 0;
    let first = null;
    const rig = createRig({ site: simpleSite(3), wrapDb: (db) => { opened++; if (!first) first = db; return db; } });
    await startIn(rig, 'reopen');
    await settle();
    first.closed = true;
    const run = await runUntilEnd(rig);
    expect(run).toMatchObject({ reason: 'complete', page: 3 });
    expect(opened).toBe(2);
  });

  test('that cannot be opened again, it ends the run loudly as storage_error', async () => {
    let opened = 0;
    let first = null;
    const wrapDb = (db) => {
      if (++opened > 1) throw Object.assign(new Error('VersionError'), { name: 'StorageError', code: 'storage_error' });
      first = db;
      return db;
    };
    const rig = createRig({ site: simpleSite(3), wrapDb });
    await startIn(rig, 'gone');
    await settle();
    first.closed = true;
    const run = await runUntilEnd(rig);
    await settle(5000);
    expect(run).toMatchObject({ state: 'failed', reason: 'storage_error', page: 1 });
    expect(served(rig, 'gone')).toEqual([1, 2]);
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st).toMatchObject({ run: { reason: 'storage_error' }, results: [], error: 'storage_error' });
  });
});

describe('products across pages (F-27, F-28)', () => {
  const PAGE1 = page(card('B0A', '$5.00', { ad: true }) + card('B0B', '$2.00') + card('B0A', '$5.00'), '/s?k=w&page=2');
  const PAGE2 = page(card('B0C', '$3.00') + card('B0A', '$5.00') + card('B0B', '$2.00', { rating: false }), null);
  const site = (url) => (pageNo(url) === 1 ? PAGE1 : PAGE2);

  async function twoPages({ lastValues = [], flags, local } = {}) {
    const rig = createRig({ site, flags, local });
    const db = await rig.db();
    await db.write(lastValues.map((v) => ({ store: 'lastValues', put: v })));
    db.close();
    await startIn(rig, 'w');
    await runUntilEnd(rig);
    return rig;
  }
  const prevRun = (asin, priceCents) => ({ asin, priceCents, rating: 4.5, reviewCount: 900, runId: 'r0', scrapedAt: null });

  test('each ASIN is stored once per run, with every placement', async () => {
    const rig = await twoPages();
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.results.map((r) => r.asin)).toEqual(['B0A', 'B0B', 'B0C']);
    expect(st.run.itemCount).toBe(3);
    const a = st.results[0];
    expect(a.url).toBe('https://www.amazon.com/dp/B0A');
    expect(a.sponsored).toBe(true);
    expect(a.organicRank).toBe(2);
    expect(a.placements).toEqual([
      { page: 1, position: 1, sponsored: true, rank: null },
      { page: 1, position: 3, sponsored: false, rank: 2 },
      { page: 2, position: 2, sponsored: false, rank: 4 },
    ]);
    expect(st.results[2]).toMatchObject({ asin: 'B0C', organicRank: 3, sponsored: false });
    expect(st.pages.map((p) => [p.count, p.placements])).toEqual([[2, 3], [1, 3]]);
  });

  test('with cloud sync off nothing goes into the outbox (F-26)', async () => {
    const rig = await twoPages({ flags: { CLOUD_SYNC: false } });
    const db = await rig.db();
    expect(await db.count('outbox')).toBe(0);
    db.close();
  });

  test('an outbox left by an older build is not grown while sync is off', async () => {
    const rig = createRig({ site, flags: { CLOUD_SYNC: false } });
    const db = await rig.db();
    await db.write([{ store: 'outbox', put: { seq: 1, runId: 'r0', pageIndex: null } }]);
    db.close();
    await startIn(rig, 'w');
    await runUntilEnd(rig);
    const after = await rig.db();
    expect(await after.getAll('outbox')).toEqual([{ seq: 1, runId: 'r0', pageIndex: null }]);
    after.close();
  });

  test('with cloud sync on but nobody signed in nothing is queued (F-26)', async () => {
    const rig = await twoPages({ flags: { CLOUD_SYNC: true } });
    const db = await rig.db();
    expect(await db.count('outbox')).toBe(0);
    db.close();
  });

  test('signed in, each page is queued once for that account, then the run (F-20, F-29e)', async () => {
    const rig = await twoPages({ flags: { CLOUD_SYNC: true }, local: { account: { uid: 'u1', email: 'a@b.c' } } });
    const run = await rig.run();
    const db = await rig.db();
    const entries = await db.getAll('outbox');
    expect(entries.map((e) => [e.kind, e.pageIndex, e.uid, e.runId])).toEqual([
      ['page', 1, 'u1', run.runId],
      ['page', 2, 'u1', run.runId],
      ['run', undefined, 'u1', run.runId],
    ]);
    db.close();
  });

  test('the run id is minted once as {sourceId}_{startMs}, with the local day key (F-20, F-29d)', async () => {
    const rig = await twoPages();
    const run = await rig.run();
    expect(run.runId).toBe(`k_w_${run.startedAt}`);
    expect(run.sourceId).toBe('k_w');
    expect(run.source).toMatchObject({ type: 'keyword', keyword: 'w', sourceId: 'k_w' });
    expect(run.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const db = await rig.db();
    expect((await db.runPages(run.runId)).map((p) => p.pageIndex)).toEqual([1, 2]);
    db.close();
  });

  test("another account's last values give no delta, and new ones carry the uid (F-29e)", async () => {
    const theirs = { ...prevRun('B0A', 600), uid: 'someone-else' };
    const anon = prevRun('B0B', 250);
    const rig = await twoPages({ lastValues: [theirs, anon], local: { account: { uid: 'u1' } } });
    const [a, b] = await results(rig);
    expect(a.delta).toMatchObject({ isNew: true });
    expect(a.prev).toBeNull();
    expect(b.delta).toMatchObject({ isNew: false, dPriceCents: -50 });
    expect(b.prev).toMatchObject({ priceCents: 250, rating: 4.5, reviewCount: 900, uid: null });
    const db = await rig.db();
    expect(await db.get('lastValues', 'B0A')).toMatchObject({ priceCents: 500, uid: 'u1' });
    db.close();
  });

  test('each page drops lastValues older than the age limit (F-26)', async () => {
    const stale = { asin: 'B0GONE', priceCents: 1, runId: 'r0', scrapedAt: new Date(Date.now() - 400 * 86400000).toISOString() };
    const rig = await twoPages({ lastValues: [stale] });
    const db = await rig.db();
    expect((await db.getAll('lastValues')).map((s) => s.asin).sort()).toEqual(['B0A', 'B0B', 'B0C']);
    db.close();
  });

  test('a repeat in the same run keeps the delta against the last run', async () => {
    const rig = await twoPages({ lastValues: [prevRun('B0A', 600), prevRun('B0B', 250)] });
    const [a, b] = await results(rig);
    expect(a.delta).toEqual({ isNew: false, dPriceCents: -100, dRating: 0, dReviews: 100 });
    // B0B lost its rating markup on page 2; the page 1 delta stays
    expect(b.delta).toEqual({ isNew: false, dPriceCents: -50, dRating: 0, dReviews: 100 });
    const db = await rig.db();
    expect(await db.get('lastValues', 'B0B')).toMatchObject({ priceCents: 200, rating: 4.5, reviewCount: 1000 });
    db.close();
  });

  test('a card with no rating gives a null delta, not a fake drop (F-28)', async () => {
    const rig = createRig({ site: () => page(card('B0B', '$2.00', { rating: false }), null) });
    const db = await rig.db();
    await db.write([{ store: 'lastValues', put: prevRun('B0B', 200) }]);
    db.close();
    await startIn(rig, 'w');
    await runUntilEnd(rig);
    const [b] = await results(rig);
    expect(b).toMatchObject({ rating: null, reviewCount: null });
    expect(b.delta).toEqual({ isNew: false, dPriceCents: 0, dRating: null, dReviews: null });
  });

  test('two runs keep their own products, and organic ranks start at 1 in each', async () => {
    const rig = createRig({ site: simpleSite(1) });
    const first = await startIn(rig, 'aaa');
    await runUntilEnd(rig);
    const firstRun = await rig.run();
    await startIn(rig, 'bbb');
    await runUntilEnd(rig);
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.results.map((r) => r.asin)).toEqual([0, 1, 2, 3].map((i) => asinFor('bbb', 1, i)));
    expect(st.results.map((r) => r.organicRank)).toEqual([1, 2, 3, 4]);
    const db = await rig.db();
    expect(await db.runProducts(firstRun.runId)).toHaveLength(4);
    expect(await db.count('lastValues')).toBe(8);
    db.close();
    expect(first.resp.ok).toBe(true);
  });
});

describe('spread results', () => {
  test('are kept per run and come back with the state', async () => {
    const rig = createRig({ site: simpleSite(1) });
    const { tab } = await startIn(rig, 'spread');
    await runUntilEnd(rig);
    const send = (msg) => new Promise((r) => rig.worker.router.listener(msg, { id: 'test-extension', tab: { id: tab } }, r));
    const got = await send({ type: 'GET_RESULTS' });
    expect(got.results).toHaveLength(4);
    await send({ type: 'SPREAD_RESULT', asin: got.results[0].asin, data: { sellerPrices: [1, 2] } });
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.spread).toEqual({ [got.results[0].asin]: { sellerPrices: [1, 2] } });
  });
});

describe('foldPage', () => {
  test('does not change the records it is given', () => {
    const before = [{ asin: 'B0A', organicRank: 1, placements: [{ page: 1, position: 1, sponsored: false, rank: 1 }] }];
    const frozen = JSON.stringify(before);
    const { fresh, changed } = foldPage(before, [
      { asin: 'B0A', sponsored: true, placements: [{ position: 1, sponsored: true, rank: null }] },
      { asin: 'B0B', sponsored: false, placements: [{ position: 2, sponsored: false, rank: 1 }] },
    ], 2);
    expect(JSON.stringify(before)).toBe(frozen);
    expect(fresh.map((p) => [p.asin, p.organicRank])).toEqual([['B0B', 2]]);
    expect(changed[0]).toMatchObject({ asin: 'B0A', sponsored: true, organicRank: 1 });
    expect(changed[0].placements).toHaveLength(2);
  });
});

describe('a run left live only in IndexedDB', () => {
  test('session storage wiped with no recover (disable and enable): the run shows as ended and Start works', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'orphan');
    await settle(1000);
    await rig.session.remove('run');
    rig.killWorker();
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.run).toMatchObject({ state: 'failed', reason: 'interrupted' });
    expect(Run.isActive(st.run)).toBe(false);
    expect(st.results).toHaveLength(4);
    const db = await rig.db();
    expect(Run.isActive(await db.get('runs', st.run.runId))).toBe(false);
    db.close();
    const tab2 = rig.openTab(searchUrl('after'));
    await settle();
    expect(await rig.popup({ type: 'START_RUN', tabId: tab2 })).toMatchObject({ ok: true });
  });

  test('Stop ends it when session storage has no run', async () => {
    const rig = createRig({ site: simpleSite(3) });
    await startIn(rig, 'orphan2');
    await settle(1000);
    await rig.session.remove('run');
    rig.killWorker();
    expect(await rig.popup({ type: 'STOP_RUN' })).toEqual({ ok: true, stopped: true });
    const st = await rig.popup({ type: 'GET_STATE' });
    expect(st.run).toMatchObject({ reason: 'stopped' });
  });
});

describe('the run tab', () => {
  test('a new search that loads while the next page is pending ends the run and is not parsed', async () => {
    const rig = createRig({ site: simpleSite(3) });
    const { tab } = await startIn(rig, 'mine');
    await settle();
    const run = await rig.run();
    await rig.session.set({ run: { ...run, awaiting: true, expectUrl: searchUrl('mine', 2), navAt: null } });
    const out = await rig.engine().pageReady({ url: searchUrl('theirs') }, { tab: { id: tab } });
    expect(out).toEqual({ idle: true });
    expect(await rig.run()).toMatchObject({ reason: 'interrupted' });
    expect((await results(rig)).map((r) => r.asin)).toEqual([0, 1, 2, 3].map((i) => asinFor('mine', 1, i)));
  });

  test('the page it opened is parsed even when Amazon rewrites qid and ref', async () => {
    const rig = createRig({ site: simpleSite(3) });
    const { tab } = await startIn(rig, 'mine');
    await settle();
    const run = await rig.run();
    await rig.session.set({ run: { ...run, awaiting: true, expectUrl: `${searchUrl('mine', 2)}&ref=sr_pg_1`, navAt: null } });
    const out = await rig.engine().pageReady({ url: `${searchUrl('mine', 2)}&qid=5&ref=sr_pg_2` }, { tab: { id: tab } });
    expect(out).toMatchObject({ parse: true, page: 2 });
  });
});

describe('old runs', () => {
  test(`starting a run keeps the newest ${require('../../scripts/background/engine').KEEP_RUNS}, and never one waiting to sync`, async () => {
    const { KEEP_RUNS } = require('../../scripts/background/engine');
    const rig = createRig({ site: simpleSite(1) });
    const db = await rig.db();
    const ops = [];
    for (let i = 0; i < KEEP_RUNS + 3; i++) {
      const runId = `old-${String(i).padStart(2, '0')}`;
      ops.push({ store: 'runs', put: { runId, state: 'done', reason: 'complete', startedAt: 1000 + i } });
      ops.push({ store: 'products', put: { runId, n: 0, asin: 'B0OLD00000' } });
      ops.push({ store: 'placements', put: { runId, pageIndex: 1, count: 1 } });
    }
    ops.push({ store: 'outbox', put: { runId: 'old-00', pageIndex: 1, queuedAt: 1 } });
    await db.write(ops);
    await startIn(rig, 'fresh');
    await runUntilEnd(rig);
    const runs = (await db.getAll('runs')).map((r) => r.runId).sort();
    // The run just made, the 9 newest old ones, and old-00 kept for the outbox.
    expect(runs).toHaveLength(KEEP_RUNS + 1);
    expect(runs).toContain('old-00');
    expect(runs).not.toContain('old-01');
    expect(await db.runProducts('old-01')).toEqual([]);
    expect(await db.runPages('old-01')).toEqual([]);
    expect(await db.runProducts(`old-${KEEP_RUNS + 2}`)).toHaveLength(1);
    db.close();
  });
});

describe('the end of a synced run (EXT9-5)', () => {
  test('signed out mid-run, the final header still goes to the account its pages went to', async () => {
    const rig = createRig({ site: simpleSite(3), flags: { CLOUD_SYNC: true }, local: { account: { uid: 'u1' } } });
    await startIn(rig, 'leave');
    await settle();
    await rig.local.remove('account');
    expect(await rig.popup({ type: 'STOP_RUN' })).toMatchObject({ stopped: true });
    const db = await rig.db();
    const outbox = await db.getAll('outbox');
    db.close();
    expect(outbox.map((e) => [e.kind, e.uid])).toEqual([['page', 'u1'], ['run', 'u1']]);
  });

  test('a run left live only in IndexedDB queues its final header when it is ended', async () => {
    const rig = createRig({ site: simpleSite(3), flags: { CLOUD_SYNC: true }, local: { account: { uid: 'u1' } } });
    await startIn(rig, 'gone');
    await settle(1000);
    await rig.session.remove('run');
    rig.killWorker();
    await rig.popup({ type: 'GET_STATE' });
    const db = await rig.db();
    const kinds = (await db.getAll('outbox')).map((e) => e.kind);
    db.close();
    expect(kinds).toContain('run');
  });
});
