/**
 * schemaVersion 2 to 3 (F-100, F-101) and 3 to 4, over storage the live 2.0 build
 * (commit 7c2ba1c) wrote in Chromium: tests/fixtures/v2.0-storage.json,
 * captured by tests/e2e/capture-v20-storage.mjs from the saved yoga mat
 * page plus one generated page.
 */
const fs = require('fs');
const path = require('path');
const Migrate = require('../../scripts/lib/migrate');
const Delta = require('../../scripts/modules/delta');
const Run = require('../../scripts/lib/run');

const V20 = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/v2.0-storage.json'), 'utf8'));
const NOW = Date.parse('2026-09-25T12:00:00Z');
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('the captured v2.0 snapshot', () => {
  test('has exactly the 2.0 keys', () => {
    expect(Object.keys(V20).sort()).toEqual(['currentItemCount', 'isScrapingActive', 'results', 'settings']);
    expect(Migrate.versionOf(V20)).toBe(2);
    // What makes the migration necessary: display prices only, sspa links, repeats.
    expect(V20.results.some((r) => 'priceCents' in r)).toBe(false);
    expect(V20.results.some((r) => /\/sspa\//.test(r.url))).toBe(true);
    expect(new Set(V20.results.map((r) => r.asin)).size).toBeLessThan(V20.results.length);
  });
});

describe('plan 2 -> 3 on the v2.0 snapshot', () => {
  const p = Migrate.plan(clone(V20), { now: NOW, to: 3 });
  const asins = [...new Set(V20.results.map((r) => r.asin))];

  test('moves to version 3', () => {
    expect(p).toMatchObject({ from: 2, to: 3 });
    expect(p.set.schemaVersion).toBe(3);
  });

  test('keeps every result row, in order', () => {
    expect(p.set.results.map((r) => r.asin)).toEqual(V20.results.map((r) => r.asin));
    expect(p.set.results.map((r) => r.scrapedAt)).toEqual(V20.results.map((r) => r.scrapedAt));
  });

  test('gives every row priceCents from its dollar price, and null for N/A', () => {
    p.set.results.forEach((r, i) => {
      const before = V20.results[i].price;
      if (before === 'N/A') {
        expect([r.price, r.priceCents]).toEqual([null, null]);
      } else {
        expect(r.priceCents).toBe(Math.round(parseFloat(before.replace(/[$,]/g, '')) * 100));
        expect(r.price).toBe(before);
      }
    });
  });

  test('rewrites every link, sponsored ones included, to /dp/{asin}', () => {
    p.set.results.forEach((r) => expect(r.url).toBe(`https://www.amazon.com/dp/${r.asin}`));
  });

  test('seeds lastValues once per ASIN from its first row', () => {
    expect(Object.keys(p.set.lastValues).sort()).toEqual([...asins].sort());
    asins.forEach((asin) => {
      const first = p.set.results.find((r) => r.asin === asin);
      expect(p.set.lastValues[asin]).toEqual({
        priceCents: first.priceCents, rating: first.rating, reviewCount: first.reviewCount,
        runId: 'legacy-2.0', scrapedAt: first.scrapedAt, firstSeenAt: first.scrapedAt,
      });
    });
  });

  test('drops the untouched 2.0 default settings and nothing else', () => {
    expect(p.remove).toEqual(['settings']);
    expect(p.set).not.toHaveProperty('currentItemCount');
    expect(p.set).not.toHaveProperty('isScrapingActive');
    expect(p.set).not.toHaveProperty(Run.KEY);
  });

  test('stays well inside the storage quota', () => {
    expect(JSON.stringify(p.set).length).toBeLessThan(1024 * 1024);
  });
});

describe('the first 2.1 scrape after the update', () => {
  test('diffs against the 2.0 values instead of calling every product new', () => {
    const p = Migrate.plan(clone(V20), { now: NOW, to: 3 });
    const seeded = p.set.lastValues;
    const asin = p.set.results.find((r) => r.priceCents !== null).asin;
    const old = seeded[asin];
    const current = { asin, priceCents: old.priceCents - 500, rating: old.rating, reviewCount: old.reviewCount + 10,
      runId: 'r-2.1', scrapedAt: '2026-10-01T00:00:00.000Z' };
    expect(Delta.computeDeltas(current, old)).toEqual({ isNew: false, dPriceCents: -500, dRating: 0, dReviews: 10 });
    const next = Delta.snapshot(current, old);
    expect(next.firstSeenAt).toBe(old.firstSeenAt);
    expect(next.runId).toBe('r-2.1');
  });
});

describe('edge cases', () => {
  test('a run cut off by the update ends as updated and is not resumed (F-101)', () => {
    const store = { ...clone(V20), isScrapingActive: true };
    const p = Migrate.plan(store, { now: NOW, to: 3 });
    expect(p.set.isScrapingActive).toBe(false);
    expect(p.set[Run.KEY]).toMatchObject({ runId: 'legacy-2.0', state: 'failed', reason: 'updated', finishedAt: NOW });
    expect(Run.isActive(p.set[Run.KEY])).toBe(false);
    expect(Run.describe(p.set[Run.KEY], 74).text).toMatch(/updated during the run/);
  });

  test('2.0 zeros and 1.x N/A become null, and a missing title is null', () => {
    const p = Migrate.plan({ results: [
      { name: 'N/A', asin: 'B0V1000001', price: 'N/A', rating: 'N/A', reviewCount: 0, url: '/dp/B0V1000001' },
      { name: 'Zero', asin: 'B0V1000002', price: '$5.00', rating: 0, reviewCount: 0, url: 'x', scrapedAt: '2026-02-20T15:00:00.000Z' },
      { name: 'Euro', asin: 'B0V1000003', price: '€19,99', rating: 4, reviewCount: 3, url: 'x' },
      { name: 'Number', asin: 'B0V1000004', price: 12.5, rating: 4, reviewCount: 3, url: 'x' },
    ] }, { now: NOW, to: 3 });
    expect(p.set.results.map((r) => [r.name, r.price, r.priceCents, r.rating, r.reviewCount])).toEqual([
      [null, null, null, null, null],
      ['Zero', '$5.00', 500, null, null],
      ['Euro', null, null, 4, 3],
      ['Number', 12.5, 1250, 4, 3],
    ]);
    expect(p.set.lastValues.B0V1000002).toMatchObject({
      scrapedAt: '2026-02-20T15:00:00.000Z', firstSeenAt: '2026-02-20T15:00:00.000Z',
    });
    expect(p.set.lastValues.B0V1000001).toMatchObject({ scrapedAt: null, firstSeenAt: null });
  });

  test('a February 2.0 scrape survives the lastValues age limit', () => {
    const p = Migrate.plan({ results: [
      { name: 'Old', asin: 'B0FEB00001', price: '$9.99', rating: 4, reviewCount: 3, url: 'x', scrapedAt: '2026-02-20T15:00:00.000Z' },
    ] }, { now: NOW, to: 3 });
    expect(Object.keys(p.set.lastValues)).toEqual(['B0FEB00001']);
  });

  test('rows with a bad ASIN are kept but not seeded', () => {
    const p = Migrate.plan({ results: [{ name: 'x', asin: 'bad', price: '$1.00', rating: 4, reviewCount: 1, url: 'u' }] }, { now: NOW, to: 3 });
    expect(p.set.results).toHaveLength(1);
    expect(p.set.results[0].url).toBe('u');
    expect(p.set.lastValues).toEqual({});
  });

  test('an existing lastValues entry is never replaced', () => {
    const mine = { priceCents: 100, rating: 4, reviewCount: 1, runId: 'r9', scrapedAt: '2026-09-01T00:00:00.000Z' };
    const p = Migrate.plan({ ...clone(V20), lastValues: { [V20.results[0].asin]: mine } }, { now: NOW, to: 3 });
    expect(p.set.lastValues[V20.results[0].asin]).toEqual(mine);
  });

  test('rows written by a newer build pass through untouched', () => {
    const row = { asin: 'B0NEW00001', runId: 'r1', price: null, priceCents: null, url: 'https://www.amazon.com/dp/B0NEW00001', rating: 0 };
    const p = Migrate.plan({ results: [row] }, { now: NOW, to: 3 });
    expect(p.set.results[0]).toEqual(row);
    expect(p.set.lastValues).toEqual({});
  });

  test('changed settings are kept', () => {
    const p = Migrate.plan({ settings: { pageDelay: 2000, maxPages: 5 } }, { now: NOW, to: 3 });
    expect(p.remove).toEqual([]);
  });

  test('empty storage just gets the version', () => {
    expect(Migrate.plan({}, { now: NOW, to: 3 })).toEqual({ from: 2, to: 3, set: { lastValues: {}, schemaVersion: 3 }, remove: [], idb: [] });
  });

  test('storage already at version 3 is left alone', () => {
    expect(Migrate.plan({ schemaVersion: 3, results: V20.results }, { to: 3 })).toBeNull();
    expect(Migrate.plan({ schemaVersion: 4, settings: {} })).toBeNull();
  });
});

describe('run against chrome.storage.local', () => {
  beforeEach(() => chrome.storage.local._reset());

  test('applies the plan and is idempotent', async () => {
    await chrome.storage.local.set(clone(V20));
    const first = await Migrate.run(chrome.storage.local, { now: NOW, to: 3 });
    expect(first.from).toBe(2);
    const after = chrome.storage.local._getStore();
    expect(after.schemaVersion).toBe(3);
    expect(after).not.toHaveProperty('settings');
    expect(Object.keys(after.lastValues).length).toBeGreaterThan(60);

    expect(await Migrate.run(chrome.storage.local, { now: NOW, to: 3 })).toBeNull();
    expect(chrome.storage.local._getStore()).toEqual(after);
  });

  test('a failed write leaves version 2 in place, to retry next time', async () => {
    await chrome.storage.local.set(clone(V20));
    chrome.storage.local._failNext();
    await expect(Migrate.run(chrome.storage.local, { now: NOW, to: 3 })).rejects.toThrow(/quota/);
    expect(chrome.storage.local._getStore()).not.toHaveProperty('schemaVersion');
    expect((await Migrate.run(chrome.storage.local, { now: NOW, to: 3 })).to).toBe(3);
  });
});

describe('3 -> 4: into IndexedDB', () => {
  require('fake-indexeddb/auto');
  const { IDBFactory } = require('fake-indexeddb');
  const DB = require('../../scripts/background/db');

  let factory;
  const openDb = () => DB.open({ indexedDB: factory });
  beforeEach(() => {
    factory = new IDBFactory();
    chrome.storage.local._reset();
  });

  // What 2.1 leaves after a two page run that is still going.
  const V21 = () => ({
    schemaVersion: 3,
    settings: { maxPages: 5 },
    geminiApiKey: 'k',
    results: [
      { asin: 'B0AAAAAAA1', runId: 'r21', name: 'One', priceCents: 100, placements: [] },
      { asin: 'B0AAAAAAA2', runId: 'r21', name: 'Two', priceCents: 200, placements: [] },
    ],
    currentItemCount: 2,
    isScrapingActive: true,
    scrapeRunId: 'r21',
    scrapeRunPageIndex: 2,
    scrapeRunMeta: { type: 'keyword', keyword: 'mats', sellerId: null, url: 'u', startedAt: 's' },
    scrapeRunPages: [{ runId: 'r21', pageIndex: 1, count: 1 }, { runId: 'r21', pageIndex: 2, count: 1 }],
    lastValues: { B0AAAAAAA1: { priceCents: 100, scrapedAt: '2026-09-20T00:00:00.000Z' } },
    spreadResults: { B0AAAAAAA1: { sellerPrices: [1, 2] } },
    run: { runId: 'r21', tabId: 7, status: 'running', page: 2, maxPages: 5, startedAt: 1, heartbeat: 2, finishedAt: null },
  });

  test('leaves only settings, the key and schemaVersion in chrome.storage.local', async () => {
    await chrome.storage.local.set(V21());
    await Migrate.run(chrome.storage.local, { now: NOW, openDb });
    expect(chrome.storage.local._getStore()).toEqual({ schemaVersion: 4, settings: { maxPages: 5 }, geminiApiKey: 'k' });
  });

  test('moves the run, its products, pages, lastValues and spread data', async () => {
    await chrome.storage.local.set(V21());
    await Migrate.run(chrome.storage.local, { now: NOW, openDb });
    const db = await openDb();
    expect(await db.getMeta('latestRunId')).toBe('r21');
    expect((await db.runProducts('r21')).map((p) => [p.n, p.asin])).toEqual([[0, 'B0AAAAAAA1'], [1, 'B0AAAAAAA2']]);
    expect((await db.runPages('r21')).map((p) => p.pageIndex)).toEqual([1, 2]);
    expect(await db.get('lastValues', 'B0AAAAAAA1')).toMatchObject({ asin: 'B0AAAAAAA1', priceCents: 100 });
    expect(await db.get('spread', ['r21', 'B0AAAAAAA1'])).toMatchObject({ data: { sellerPrices: [1, 2] } });
    const run = await db.get('runs', 'r21');
    expect(run).toMatchObject({ state: 'failed', reason: 'updated', itemCount: 2, source: { keyword: 'mats' } });
    expect(run).not.toHaveProperty('status');
    expect(Run.describe(run, 2).text).toMatch(/updated during the run/);
    db.close();
  });

  test('a finished 2.1 run keeps how it ended', async () => {
    await chrome.storage.local.set({ ...V21(), isScrapingActive: false, run: { ...V21().run, status: 'blocked', finishedAt: 5 } });
    await Migrate.run(chrome.storage.local, { now: NOW, openDb });
    const db = await openDb();
    expect(await db.get('runs', 'r21')).toMatchObject({ state: 'blocked', reason: 'blocked', finishedAt: 5 });
    db.close();
  });

  test('a 2.0 user goes to 4 in one go and keeps every row, repeats included', async () => {
    await chrome.storage.local.set(clone(V20));
    const p = await Migrate.run(chrome.storage.local, { now: NOW, openDb });
    expect(p).toMatchObject({ from: 2, to: 4 });
    expect(chrome.storage.local._getStore()).toEqual({ schemaVersion: 4 });
    const db = await openDb();
    expect(await db.getMeta('latestRunId')).toBe('legacy-2.0');
    const rows = await db.runProducts('legacy-2.0');
    expect(rows.map((r) => r.asin)).toEqual(V20.results.map((r) => r.asin));
    expect(rows.every((r) => r.url === `https://www.amazon.com/dp/${r.asin}`)).toBe(true);
    expect(await db.count('lastValues')).toBe(new Set(V20.results.map((r) => r.asin)).size);
    expect(await db.get('runs', 'legacy-2.0')).toMatchObject({ state: 'done', reason: 'complete' });
    db.close();
  });

  test('without IndexedDB nothing is removed', async () => {
    await chrome.storage.local.set(V21());
    await expect(Migrate.run(chrome.storage.local, { now: NOW })).rejects.toThrow(/IndexedDB/);
    expect(chrome.storage.local._getStore()).toEqual(V21());
  });

  test('a failed IndexedDB write leaves version 3 in place, and the retry is clean', async () => {
    await chrome.storage.local.set(V21());
    const failing = async () => ({ write: async () => { throw Object.assign(new Error('quota'), { code: 'storage_full' }); } });
    await expect(Migrate.run(chrome.storage.local, { now: NOW, openDb: failing })).rejects.toThrow(/quota/);
    expect(chrome.storage.local._getStore().schemaVersion).toBe(3);
    expect(chrome.storage.local._getStore().results).toHaveLength(2);

    await Migrate.run(chrome.storage.local, { now: NOW, openDb });
    // A second copy of the data, as if the first removal had failed, lands on the same keys.
    await Migrate.run({ get: async () => V21(), remove: async () => {}, set: async () => {} }, { now: NOW, openDb });
    const db = await openDb();
    expect(await db.count('products')).toBe(2);
    expect(await db.count('placements')).toBe(2);
    db.close();
  });

  test('queued products from an unreleased build keep their run and are queued once', async () => {
    const queued = [{ asin: 'B0QQQQQQQ1', runId: 'r0' }, { asin: 'B0AAAAAAA1', runId: 'r21' }];
    await chrome.storage.local.set({ ...V21(), syncQueue: queued });
    await Migrate.run(chrome.storage.local, { now: NOW, openDb });
    const db = await openDb();
    expect((await db.runProducts('r0')).map((p) => p.asin)).toEqual(['B0QQQQQQQ1']);
    expect((await db.getAll('outbox')).map((o) => o.runId).sort()).toEqual(['r0', 'r21']);
    db.close();
  });
});
