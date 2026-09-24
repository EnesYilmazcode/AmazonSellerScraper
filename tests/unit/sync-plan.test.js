/**
 * @jest-environment node
 *
 * The pure sync plan: outbox entry and IndexedDB records in, cloud writes out.
 */
const { planEntry, firstSeenCandidates, runKeys, checkRuleCaps, RULE_CAPS, DELETE } = require('../../scripts/background/sync-plan.js');
const S = require('../../packages/schema/index.js');

const START = Date.parse('2026-06-09T14:02:11Z');
const RUN_ID = `k_mug_${START}`;

const run = (patch = {}) => ({
  runId: RUN_ID, sourceId: 'k_mug', dayKey: '2026-06-09', state: 'running', reason: null,
  source: { type: 'keyword', sellerId: null, keyword: 'mug', url: 'https://www.amazon.com/s?k=mug', sourceId: 'k_mug' },
  startedAt: START, finishedAt: null, page: 2, maxPages: 20, itemCount: 3,
  ...patch,
});

const product = (asin, patch = {}) => ({
  asin, name: `Mug ${asin}`, priceCents: 1999, rating: 4.5, reviewCount: 100, isPrime: true,
  sponsored: false, organicRank: 1, img: null, runId: RUN_ID, pageIndex: 1,
  scrapedAt: '2026-06-09T14:03:00.000Z',
  placements: [{ page: 1, position: 1, sponsored: false, rank: 1 }],
  delta: { isNew: true, dPriceCents: null, dRating: null, dReviews: null }, prev: null,
  ...patch,
});

const pages = [
  { runId: RUN_ID, pageIndex: 1, count: 2, placements: 3, kind: 'results', scrapedAt: '2026-06-09T14:03:00.000Z', total: 412 },
  { runId: RUN_ID, pageIndex: 2, count: 1, placements: 2, kind: 'last', scrapedAt: '2026-06-09T14:03:05.000Z', total: 412 },
];

const products = [
  product('B0AAAAAAA1', {
    sponsored: true,
    placements: [
      { page: 1, position: 1, sponsored: true, rank: null },
      { page: 2, position: 2, sponsored: false, rank: 3 },
    ],
    organicRank: 3,
  }),
  product('B0AAAAAAA2', {
    priceCents: null, organicRank: 1, placements: [{ page: 1, position: 2, sponsored: false, rank: 1 }],
    delta: { isNew: false, dPriceCents: null, dRating: 0, dReviews: 5 },
    prev: { priceCents: 2100, rating: 4.5, reviewCount: 95, scrapedAt: '2026-06-02T14:00:00.000Z', uid: 'u1' },
  }),
  product('B0AAAAAAA3', { pageIndex: 2, organicRank: 2, placements: [{ page: 2, position: 1, sponsored: false, rank: 2 }] }),
];

const entry = (patch) => ({ seq: 1, runId: RUN_ID, uid: 'u1', ...patch });
const byPath = (writes) => Object.fromEntries(writes.map((w) => [w.path.join('/'), w]));
/** A merge write's data without the deletes that clear stale keys. */
const kept = (data) => Object.fromEntries(Object.entries(data)
  .filter(([, v]) => v !== DELETE)
  .map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).includes(DELETE)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== DELETE)) : v]));

describe('a page entry', () => {
  const writes = planEntry({ entry: entry({ kind: 'page', pageIndex: 1 }), run: run(), products, pages });
  const w = byPath(writes);

  test('writes the chunk, each ASIN on the page twice, the run and the source', () => {
    expect(writes.map((x) => x.path.slice(2).join('/'))).toEqual([
      `runs/${RUN_ID}/pages/p0001`,
      'products/B0AAAAAAA1', 'products/B0AAAAAAA1/history/daily',
      'products/B0AAAAAAA2', 'products/B0AAAAAAA2/history/daily',
      `runs/${RUN_ID}`,
      'sources/k_mug',
    ]);
    expect(writes.every((x) => x.path[0] === 'workspaces' && x.path[1] === 'u1')).toBe(true);
  });

  test('the chunk keeps every ASIN on the page with its sponsored flag and rank', () => {
    const chunk = w[`workspaces/u1/runs/${RUN_ID}/pages/p0001`];
    expect(chunk.fields).toBeNull();
    expect(chunk.data).toMatchObject({ sv: S.SV, page: 1, count: 2, placements: 3, kind: 'results', total: 412 });
    expect(chunk.data.items).toEqual({
      B0AAAAAAA1: { p: 1999, r: 4.5, v: 100, pr: 1, sp: 1 },
      B0AAAAAAA2: { r: 4.5, v: 100, pr: 1, rk: 1, sp: 0 },
    });
    expect(chunk.data.expireAt).toBe(START + S.PAGE_TTL_DAYS * 86400000);
  });

  test('latest, prev and delta are replaced whole, and a failed price leaves no stale value (F-21)', () => {
    const doc = w['workspaces/u1/products/B0AAAAAAA2'];
    // A merge write, so sourceIds accumulates (NEW-SYNC-1); every key a map lacks is deleted.
    expect(doc.merge).toBe(true);
    expect(doc.data.latest.p).toBe(DELETE);
    expect(doc.data.delta.p).toBe(DELETE);
    expect(doc.data.delta.pPct).toBe(DELETE);
    expect(doc.data.sourceIds).toEqual(['k_mug']);
    const d = kept(doc.data);
    expect(d.latest).toEqual({ r: 4.5, v: 100, pr: 1, rk: 1, at: Date.parse('2026-06-09T14:03:00.000Z'), runId: RUN_ID, dayKey: '2026-06-09' });
    expect(d.prev).toEqual({ p: 2100, r: 4.5, v: 95, at: Date.parse('2026-06-02T14:00:00.000Z') });
    // No price this run, so no price delta; the rest compares
    expect(d.delta).toEqual({ r: 0, v: 5, days: 7 });
  });

  test('a product seen for the first time has a null delta and no prev', () => {
    const doc = kept(w['workspaces/u1/products/B0AAAAAAA1'].data);
    expect(doc.delta).toBeNull();
    expect(doc.prev).toBeNull();
    expect(doc.latest.rk).toBe(3);
    expect(doc.name).toBe('Mug B0AAAAAAA1');
    expect(doc).not.toHaveProperty('img');
    expect(doc).not.toHaveProperty('firstSeenAt');
  });

  test('history writes only its own day', () => {
    const h = w['workspaces/u1/products/B0AAAAAAA1/history/daily'];
    expect(h.fields).toEqual(['sv', 'asin', ['d', '2026-06-09']]);
    expect(h.data).toEqual({ sv: S.SV, asin: 'B0AAAAAAA1', d: { '2026-06-09': { p: 1999, r: 4.5, v: 100, pr: 1, rk: 3 } } });
  });

  test('the run header is active with counters from the whole run', () => {
    const h = w[`workspaces/u1/runs/${RUN_ID}`].data;
    expect(h).toMatchObject({
      sv: S.SV, runId: RUN_ID, sourceId: 'k_mug', mk: 'US', dayKey: '2026-06-09', status: 'active',
      finishedAt: null, reason: null, pagesDone: 2, maxPages: 20, pagesPlanned: null, totalResultsOnSerp: 412,
      counters: { placements: 4, uniqueAsins: 3, sponsored: 1, priceParseFailures: 1, newSeen: 2 },
    });
    expect(h.source).toEqual({ type: 'keyword', sellerId: null, keyword: 'mug', url: 'https://www.amazon.com/s?k=mug' });
  });

  test('the source never touches the fields the dashboard owns', () => {
    const src = w['workspaces/u1/sources/k_mug'];
    expect(src.fields.sort()).toEqual(['catalogSize', 'keyword', 'lastRunId', 'lastScrapedAt', 'sellerId', 'sourceId', 'sv', 'type', 'url']);
  });
});

test('a repeat on a later page is in that page\'s chunk and product writes', () => {
  const writes = planEntry({ entry: entry({ kind: 'page', pageIndex: 2 }), run: run(), products, pages });
  const chunk = byPath(writes)[`workspaces/u1/runs/${RUN_ID}/pages/p0002`].data;
  expect(Object.keys(chunk.items)).toEqual(['B0AAAAAAA1', 'B0AAAAAAA3']);
  expect(chunk.items.B0AAAAAAA1).toMatchObject({ sp: 0, rk: 3 });
});

test('firstSeenAt goes only on documents the caller found missing (F-29b)', () => {
  const writes = planEntry({ entry: entry({ kind: 'page', pageIndex: 1 }), run: run(), products, pages, missing: new Set(['B0AAAAAAA1']) });
  const w = byPath(writes);
  expect(w['workspaces/u1/products/B0AAAAAAA1'].data).toMatchObject({ firstSeenAt: Date.parse('2026-06-09T14:03:00.000Z'), firstRunId: RUN_ID });
  expect(w['workspaces/u1/products/B0AAAAAAA2'].data).not.toHaveProperty('firstSeenAt');
});

test('first-seen candidates: new here, or last seen by nobody signed in to this account', () => {
  const list = [
    product('B0NEW00001'),
    product('B0MINE0001', { prev: { uid: 'u1' } }),
    product('B0ANON0001', { prev: { uid: null } }),
    product('B0ELSE0001', { placements: [{ page: 2, position: 1, sponsored: false, rank: 1 }] }),
  ];
  expect(firstSeenCandidates(entry({ kind: 'page', pageIndex: 1 }), list)).toEqual(['B0NEW00001', 'B0ANON0001']);
  expect(firstSeenCandidates(entry({ kind: 'run' }), list)).toEqual([]);
});

test('a run entry writes the final header and the source only', () => {
  const ended = run({ state: 'blocked', reason: 'blocked', finishedAt: START + 60000 });
  const writes = planEntry({ entry: entry({ kind: 'run' }), run: ended, products, pages });
  expect(writes.map((x) => x.path.slice(2).join('/'))).toEqual([`runs/${RUN_ID}`, 'sources/k_mug']);
  expect(writes[0].data).toMatchObject({ status: 'stopped', reason: 'blocked', finishedAt: START + 60000, pagesPlanned: null });
  const done = planEntry({ entry: entry({ kind: 'run' }), run: run({ state: 'done', reason: 'complete', finishedAt: START + 1 }), products, pages });
  expect(done[0].data).toMatchObject({ status: 'complete', pagesPlanned: 2 });
});

test('times and array unions go through the converters the sync module passes', () => {
  const writes = planEntry({
    entry: entry({ kind: 'page', pageIndex: 1 }), run: run(), products, pages,
    time: (ms) => ({ toMillis: () => ms, ms }), union: (vals) => ({ union: vals }),
  });
  const p = byPath(writes)['workspaces/u1/products/B0AAAAAAA1'].data;
  expect(p.sourceIds).toEqual({ union: ['k_mug'] });
  expect(p.latest.at.ms).toBe(Date.parse('2026-06-09T14:03:00.000Z'));
});

test('a run from before 2.3 still gets its source id and day key', () => {
  const old = { runId: '1749477731000-abc', source: { type: 'storefront', sellerId: 'A3K9XELT4QZ6M2', url: 'https://www.amazon.com/s?me=A3K9XELT4QZ6M2' }, startedAt: START };
  expect(runKeys(old)).toMatchObject({ sourceId: 's_A3K9XELT4QZ6M2', source: { type: 'storefront', sellerId: 'A3K9XELT4QZ6M2' } });
  expect(runKeys(old).dayKey).toBe(S.dayKeyOf(START, new Date(START).getTimezoneOffset()));
});

test('with header false a page entry leaves out the run header and the source; a run entry keeps them', () => {
  const page = planEntry({ entry: entry({ kind: 'page', pageIndex: 1 }), run: run(), products, pages, header: false });
  expect(page.map((x) => x.path.slice(2).join('/'))).not.toContain(`runs/${RUN_ID}`);
  expect(page.map((x) => x.path.slice(2).join('/'))).not.toContain('sources/k_mug');
  const end = planEntry({ entry: entry({ kind: 'run' }), run: run({ state: 'done', reason: 'complete', finishedAt: START + 1 }), products, pages, header: false });
  expect(end.map((x) => x.path.slice(2).join('/'))).toEqual([`runs/${RUN_ID}`, 'sources/k_mug']);
});

describe('rules caps (EXT9-1)', () => {
  test('a keyword or URL longer than the rules allow is cut to the cap', () => {
    const long = 'a'.repeat(310);
    const r = run({ source: { type: 'keyword', sellerId: null, keyword: long, url: `https://www.amazon.com/s?k=${long}`, sourceId: 'k_mug' } });
    const src = byPath(planEntry({ entry: entry({ kind: 'run' }), run: r, products, pages }))['workspaces/u1/sources/k_mug'].data;
    expect(src.keyword.length).toBeLessThanOrEqual(RULE_CAPS.keyword);
    expect(src.url.length).toBeLessThanOrEqual(RULE_CAPS.url);
  });

  test('a product the rules would refuse fails planning', () => {
    const big = [product('B0AAAAAAA1', { name: 'n'.repeat(RULE_CAPS.name + 1) })];
    expect(() => planEntry({ entry: entry({ kind: 'page', pageIndex: 1 }), run: run(), products: big, pages })).toThrow(/rules cap/);
  });

  test('checkRuleCaps passes documents inside the caps', () => {
    expect(() => checkRuleCaps('source', { sourceId: 'k_mug', keyword: 'mug', url: 'u', sellerId: null, lastRunId: RUN_ID })).not.toThrow();
    expect(() => checkRuleCaps('run', { reason: 'r'.repeat(101), maxPages: 5 })).toThrow(/reason/);
  });
});
