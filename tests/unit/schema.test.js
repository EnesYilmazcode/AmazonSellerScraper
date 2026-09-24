/**
 * @jest-environment node
 *
 * The shared cloud schema: id builders, points, deltas and validators.
 */
const S = require('../../packages/schema/index.js');

describe('source ids (F-29d)', () => {
  const idOf = (url) => S.sourceIdOf(S.sourceOf(url));

  test('a storefront is s_{seller}, from me=, seller= or rh', () => {
    expect(idOf('https://www.amazon.com/s?me=A3K9XELT4QZ6M2&marketplaceID=ATVPDKIKX0DER')).toBe('s_A3K9XELT4QZ6M2');
    expect(idOf('https://www.amazon.com/s?seller=a3k9xelt4qz6m2')).toBe('s_A3K9XELT4QZ6M2');
    expect(idOf('https://www.amazon.com/s?i=merchant-items&rh=p_6%3AA3K9XELT4QZ6M2')).toBe('s_A3K9XELT4QZ6M2');
    expect(idOf('https://www.amazon.com/s?rh=n%3A1055398%2Cme%3AA3K9XELT4QZ6M2')).toBe('s_A3K9XELT4QZ6M2');
    expect(S.sourceOf('https://www.amazon.com/s?me=A3K9XELT4QZ6M2&k=mug')).toMatchObject({ type: 'storefront', keyword: 'mug' });
  });

  test('a keyword is k_{slug}, the same for the same search', () => {
    expect(idOf('https://www.amazon.com/s?k=Yoga+Mat&page=2')).toBe('k_yoga-mat');
    expect(idOf('https://www.amazon.com/s?k=yoga%20mat&ref=sr_pg_3')).toBe('k_yoga-mat');
  });

  test('non-ASCII and long keywords get a hash, so they never collide', () => {
    const a = idOf('https://www.amazon.com/s?k=%E6%9D%AF%E5%AD%90');
    const b = idOf('https://www.amazon.com/s?k=%E7%A2%97');
    expect(a).toMatch(/^k_h[0-9a-z]+$/);
    expect(a).not.toBe(b);
    expect(idOf('https://www.amazon.com/s?k=caf%C3%A9+mug')).toMatch(/^k_caf-mug-h[0-9a-z]+$/);
    const long = idOf('https://www.amazon.com/s?k=' + 'a'.repeat(90));
    expect(long.length).toBeLessThan(80);
    expect(long).not.toBe(idOf('https://www.amazon.com/s?k=' + 'a'.repeat(91)));
  });

  test('a search with neither gets an id from its query, not a shared k_unknown', () => {
    const a = idOf('https://www.amazon.com/s?i=kitchen&rh=n%3A289814&page=2&qid=1');
    expect(a).toMatch(/^k_x[0-9a-z]+$/);
    expect(a).toBe(idOf('https://www.amazon.com/s?rh=n%3A289814&i=kitchen&qid=9'));
    expect(a).not.toBe(idOf('https://www.amazon.com/s?i=kitchen&rh=n%3A289815'));
    expect(S.sourceIdOf(S.sourceOf('not a url'))).toBe('k_unknown');
  });

  test('run and page ids', () => {
    expect(S.runIdOf('k_mug', 1749477731000)).toBe('k_mug_1749477731000');
    expect(S.pageIdOf(3)).toBe('p0003');
  });
});

test('the day key is the local date of the scan', () => {
  const ms = Date.parse('2026-06-10T02:30:00Z');
  expect(S.dayKeyOf(ms, 0)).toBe('2026-06-10');
  // 10:30 pm in New York (UTC-4) is still June 9 there
  expect(S.dayKeyOf(ms, 240)).toBe('2026-06-09');
});

test('run status from the extension state', () => {
  expect(S.runStatusOf('running')).toBe('active');
  expect(S.runStatusOf('done')).toBe('complete');
  expect(S.runStatusOf('stopped')).toBe('stopped');
  expect(S.runStatusOf('blocked')).toBe('stopped');
  expect(S.runStatusOf('failed')).toBe('dead');
});

describe('points and deltas', () => {
  test('unknown values are left out, never 0 (F-28)', () => {
    expect(S.pointOf({ priceCents: null, rating: null, reviewCount: null, isPrime: false, organicRank: null })).toEqual({ pr: 0 });
    expect(S.pointOf({ priceCents: 1999, rating: 4.56, reviewCount: 0, isPrime: true, organicRank: 3 }))
      .toEqual({ p: 1999, r: 4.6, v: 0, pr: 1, rk: 3 });
  });

  test('a delta compares only what both sides know, and is null otherwise (F-21)', () => {
    expect(S.deltaOf({ p: 900, r: 4.5 }, { p: 1000, r: 4.4, v: 10 }, 7)).toEqual({ p: -100, pPct: -10, r: 0.1, days: 7 });
    expect(S.deltaOf({ r: 4.5 }, { p: 1000 })).toBeNull();
    expect(S.deltaOf({ p: 900 }, null)).toBeNull();
    expect(S.deltaOf({ p: 900 }, { p: 0 })).toEqual({ p: 900 });
  });

  test('time from numbers, dates, ISO strings and Timestamps', () => {
    expect(S.timeMs(5)).toBe(5);
    expect(S.timeMs(new Date(7))).toBe(7);
    expect(S.timeMs('1970-01-01T00:00:00.009Z')).toBe(9);
    expect(S.timeMs({ toMillis: () => 11 })).toBe(11);
    expect(S.timeMs('nope')).toBeNull();
  });
});

describe('validators', () => {
  const run = {
    sv: S.SV, runId: 'k_mug_1', sourceId: 'k_mug',
    source: { type: 'keyword', sellerId: null, keyword: 'mug', url: 'https://www.amazon.com/s?k=mug' },
    mk: 'US', dayKey: '2026-06-09', startedAt: 1, finishedAt: null, status: 'active', reason: null,
    pagesDone: 1, maxPages: 20, pagesPlanned: null, totalResultsOnSerp: 412,
    counters: { placements: 3, uniqueAsins: 2, sponsored: 1, priceParseFailures: 0, newSeen: 2 },
  };
  const product = {
    sv: S.SV, asin: 'B0C8XL4N2P', mk: 'US', name: 'Mug', url: 'https://www.amazon.com/dp/B0C8XL4N2P', img: null,
    latest: { p: 2399, pr: 1, at: 5, runId: 'k_mug_1', dayKey: '2026-06-09' },
    prev: null, delta: null, sourceIds: ['k_mug'],
  };

  test('good documents pass', () => {
    expect(S.validateRun(run)).toEqual([]);
    expect(S.validateProduct(product)).toEqual([]);
    expect(S.validateSource({ sv: S.SV, sourceId: 'k_mug', type: 'keyword', sellerId: null, keyword: 'mug', url: null, lastRunId: 'k_mug_1', lastScrapedAt: 1 })).toEqual([]);
    expect(S.validatePage({ sv: S.SV, runId: 'k_mug_1', page: 1, scrapedAt: 1, expireAt: 2, count: 1, placements: 1, kind: 'last', items: { B0C8XL4N2P: { p: 1, sp: 0 } } })).toEqual([]);
    expect(S.validateHistory({ sv: S.SV, asin: 'B0C8XL4N2P', d: { '2026-06-09': { p: 1 } } })).toEqual([]);
  });

  test('every document carries sv', () => {
    expect(S.validateRun({ ...run, sv: undefined })).toContain(`sv: expected ${S.SV}`);
  });

  test('money must be whole cents and unknowns must be left out', () => {
    const bad = { ...product, latest: { ...product.latest, p: 23.99, r: null } };
    const errs = S.validateProduct(bad);
    expect(errs).toContain('latest.p: cents must be a whole number');
    expect(errs).toContain('latest.r: unknown values are left out, not null');
    expect(() => S.assertValid('product', bad)).toThrow(/invalid product document/);
  });

  test('the ASIN, status and the page size limit are checked', () => {
    expect(S.validateProduct({ ...product, asin: 'b0-bad' })).toContain('asin: 10 letters and digits');
    expect(S.validateRun({ ...run, status: 'blocked' })[0]).toMatch(/^status/);
    expect(S.validateRun({ ...run, finishedAt: 9 })).toContain('finishedAt: null while active');
    const items = {};
    for (let i = 0; i <= S.MAX_PAGE_ITEMS; i++) items[`B${String(i).padStart(9, '0')}`] = { p: 1 };
    expect(S.validatePage({ sv: S.SV, runId: 'r', page: 1, scrapedAt: 1, expireAt: 2, count: 0, placements: 0, items }))
      .toContain(`items: at most ${S.MAX_PAGE_ITEMS}`);
  });
});
