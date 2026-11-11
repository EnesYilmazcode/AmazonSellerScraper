/**
 * schemaVersion 2 to 3 (F-100, F-101), over storage the live 2.0 build
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
  const p = Migrate.plan(clone(V20), { now: NOW });
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
    const p = Migrate.plan(clone(V20), { now: NOW });
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
    const p = Migrate.plan(store, { now: NOW });
    expect(p.set.isScrapingActive).toBe(false);
    expect(p.set[Run.KEY]).toMatchObject({ runId: 'legacy-2.0', status: 'updated', finishedAt: NOW });
    expect(Run.isActive(p.set[Run.KEY])).toBe(false);
    expect(Run.describe(p.set[Run.KEY], 74).text).toMatch(/updated during the run/);
  });

  test('2.0 zeros and 1.x N/A become null, and a missing title is null', () => {
    const p = Migrate.plan({ results: [
      { name: 'N/A', asin: 'B0V1000001', price: 'N/A', rating: 'N/A', reviewCount: 0, url: '/dp/B0V1000001' },
      { name: 'Zero', asin: 'B0V1000002', price: '$5.00', rating: 0, reviewCount: 0, url: 'x', scrapedAt: '2026-02-20T15:00:00.000Z' },
      { name: 'Euro', asin: 'B0V1000003', price: '€19,99', rating: 4, reviewCount: 3, url: 'x' },
      { name: 'Number', asin: 'B0V1000004', price: 12.5, rating: 4, reviewCount: 3, url: 'x' },
    ] }, { now: NOW });
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
    ] }, { now: NOW });
    expect(Object.keys(p.set.lastValues)).toEqual(['B0FEB00001']);
  });

  test('rows with a bad ASIN are kept but not seeded', () => {
    const p = Migrate.plan({ results: [{ name: 'x', asin: 'bad', price: '$1.00', rating: 4, reviewCount: 1, url: 'u' }] }, { now: NOW });
    expect(p.set.results).toHaveLength(1);
    expect(p.set.results[0].url).toBe('u');
    expect(p.set.lastValues).toEqual({});
  });

  test('an existing lastValues entry is never replaced', () => {
    const mine = { priceCents: 100, rating: 4, reviewCount: 1, runId: 'r9', scrapedAt: '2026-09-01T00:00:00.000Z' };
    const p = Migrate.plan({ ...clone(V20), lastValues: { [V20.results[0].asin]: mine } }, { now: NOW });
    expect(p.set.lastValues[V20.results[0].asin]).toEqual(mine);
  });

  test('rows written by a newer build pass through untouched', () => {
    const row = { asin: 'B0NEW00001', runId: 'r1', price: null, priceCents: null, url: 'https://www.amazon.com/dp/B0NEW00001', rating: 0 };
    const p = Migrate.plan({ results: [row] }, { now: NOW });
    expect(p.set.results[0]).toEqual(row);
    expect(p.set.lastValues).toEqual({});
  });

  test('changed settings are kept', () => {
    const p = Migrate.plan({ settings: { pageDelay: 2000, maxPages: 5 } }, { now: NOW });
    expect(p.remove).toEqual([]);
  });

  test('empty storage just gets the version', () => {
    expect(Migrate.plan({}, { now: NOW })).toEqual({ from: 2, to: 3, set: { lastValues: {}, schemaVersion: 3 }, remove: [] });
  });

  test('storage already at version 3 is left alone', () => {
    expect(Migrate.plan({ schemaVersion: 3, results: V20.results })).toBeNull();
  });
});

describe('run against chrome.storage.local', () => {
  beforeEach(() => chrome.storage.local._reset());

  test('applies the plan and is idempotent', async () => {
    await chrome.storage.local.set(clone(V20));
    const first = await Migrate.run(chrome.storage.local, { now: NOW });
    expect(first.from).toBe(2);
    const after = chrome.storage.local._getStore();
    expect(after.schemaVersion).toBe(3);
    expect(after).not.toHaveProperty('settings');
    expect(Object.keys(after.lastValues).length).toBeGreaterThan(60);

    expect(await Migrate.run(chrome.storage.local, { now: NOW })).toBeNull();
    expect(chrome.storage.local._getStore()).toEqual(after);
  });

  test('a failed write leaves version 2 in place, to retry next time', async () => {
    await chrome.storage.local.set(clone(V20));
    chrome.storage.local._failNext();
    await expect(Migrate.run(chrome.storage.local, { now: NOW })).rejects.toThrow(/quota/);
    expect(chrome.storage.local._getStore()).not.toHaveProperty('schemaVersion');
    expect((await Migrate.run(chrome.storage.local, { now: NOW })).to).toBe(3);
  });
});
