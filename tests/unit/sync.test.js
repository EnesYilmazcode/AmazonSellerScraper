/**
 * @fileoverview Offline unit test for scripts/background/sync.js syncToCloud.
 *
 * sync.js is authored as ESM and bundled into the service worker by esbuild.
 * Here it is loaded through a tiny scoped Jest transform (see jest.config.js)
 * that rewrites its import/export to CommonJS, with firebase/firestore and the
 * firebase-init db fully mocked so the test never touches a real Firebase.
 *
 * We assert syncToCloud issues the cloud-schema writes the dashboard depends on
 * (products/{asin} with latest + delta, products/{asin}/history/daily,
 * runs/{runId}, sources/{sourceId}) and returns {written, runId, products}.
 */

// ── Mock firebase/firestore: record every doc path and set() payload. ──
// All recording state lives INSIDE the factory (Jest hoists jest.mock above
// the file, so the factory may not close over outer variables) and is exposed
// via __writes / __committed / __reset on the mocked module.
jest.mock('firebase/firestore', () => {
  const writes = [];
  const state = { committed: 0 };
  const makeBatch = () => ({
    set(ref, data, opts) {
      writes.push({ path: ref.__path, data, opts });
    },
    async commit() {
      state.committed++;
    },
  });
  return {
    // doc(db, 'workspaces', uid, 'products', asin, ...) -> ref carrying its path
    doc: (_db, ...segments) => ({ __path: segments.join('/') }),
    writeBatch: () => makeBatch(),
    serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }),
    arrayUnion: (...vals) => ({ __arrayUnion: vals }),
    Timestamp: { fromDate: (d) => ({ __ts: d.toISOString() }) },
    // test-only handles
    __writes: writes,
    __state: state,
    __reset: () => {
      writes.length = 0;
      state.committed = 0;
    },
  };
});

// ── Mock the firebase-init db (sync.js imports { db } from it) ──
jest.mock('../../scripts/background/firebase-init.js', () => ({ db: { __db: true } }), {
  virtual: true,
});

const firestoreMock = require('firebase/firestore');
const writes = firestoreMock.__writes;
const { syncToCloud } = require('../../scripts/background/sync.js');

const UID = 'user_abc';

function seedBundle() {
  return {
    scrapeRunMeta: {
      type: 'keyword',
      keyword: 'wireless mouse',
      sellerId: null,
      url: 'https://www.amazon.com/s?k=wireless+mouse',
      startedAt: '2026-06-21T10:00:00.000Z',
    },
    scrapeRunPages: [{ pageIndex: 0 }, { pageIndex: 1 }],
    syncQueue: [
      {
        // first-sight product
        asin: 'B0NEW00001',
        name: 'New Mouse',
        url: 'https://www.amazon.com/dp/B0NEW00001',
        priceCents: 1999,
        rating: 4.5,
        reviewCount: 120,
        isPrime: true,
        scrapedAt: '2026-06-21T10:00:05.000Z',
        delta: { isNew: true, dPriceCents: null, dRating: null, dReviews: null },
      },
      {
        // returning product with a price drop
        asin: 'B0SEEN00002',
        name: 'Seen Mouse',
        url: 'https://www.amazon.com/dp/B0SEEN00002',
        priceCents: 1799,
        rating: 4.2,
        reviewCount: 300,
        isPrime: false,
        scrapedAt: '2026-06-21T10:00:06.000Z',
        delta: { isNew: false, dPriceCents: -200, dRating: 0, dReviews: 20 },
      },
    ],
  };
}

const findWrite = (path) => writes.find((w) => w.path === path);

describe('sync.js — syncToCloud', () => {
  beforeEach(() => {
    firestoreMock.__reset();
  });

  test('returns {written:0, runId:null, products:0} for an empty queue', async () => {
    const res = await syncToCloud(UID, { syncQueue: [] });
    expect(res).toEqual({ written: 0, runId: null, products: 0 });
    expect(writes).toHaveLength(0);
  });

  test('derives a canonical keyword runId/sourceId from run meta', async () => {
    const res = await syncToCloud(UID, seedBundle());
    const sourceId = 'k_wireless-mouse';
    const startMs = Date.parse('2026-06-21T10:00:00.000Z');
    expect(res.runId).toBe(`${sourceId}_${startMs}`);
  });

  test('writes products/{asin} with latest (incl. dayKey) + sourceIds', async () => {
    await syncToCloud(UID, seedBundle());
    const p = findWrite(`workspaces/${UID}/products/B0NEW00001`);
    expect(p).toBeDefined();
    expect(p.opts).toEqual({ merge: true });
    expect(p.data.asin).toBe('B0NEW00001');
    expect(p.data.mk).toBe('US');
    expect(p.data.latest.p).toBe(1999);
    expect(p.data.latest.pr).toBe(1); // isPrime -> 1
    expect(p.data.latest.dayKey).toBe('2026-06-21');
    expect(p.data.sourceIds).toEqual({ __arrayUnion: ['k_wireless-mouse'] });
    // first-sight stamps present on a new product
    expect(p.data.firstRunId).toBeDefined();
    expect(p.data.firstSeenAt).toBeDefined();
  });

  test('writes a delta block for a returning product, not for a new one', async () => {
    await syncToCloud(UID, seedBundle());
    const seen = findWrite(`workspaces/${UID}/products/B0SEEN00002`);
    const fresh = findWrite(`workspaces/${UID}/products/B0NEW00001`);
    expect(seen.data.delta).toMatchObject({ p: -200, v: 20 });
    expect(seen.data.delta.pPct).toBeCloseTo(-10, 1); // -200 on prior 1999
    expect(fresh.data.delta).toBeUndefined();
    expect(fresh.data.firstRunId).toBeDefined();
    // returning product gets no first-sight stamp
    expect(seen.data.firstRunId).toBeUndefined();
  });

  test('writes the date-keyed history/daily point per product', async () => {
    await syncToCloud(UID, seedBundle());
    const h = findWrite(`workspaces/${UID}/products/B0NEW00001/history/daily`);
    expect(h).toBeDefined();
    expect(h.opts).toEqual({ merge: true });
    expect(h.data.d['2026-06-21']).toMatchObject({ p: 1999, r: 4.5, v: 120, pr: 1 });
  });

  test('writes the run header doc with counters', async () => {
    await syncToCloud(UID, seedBundle());
    const startMs = Date.parse('2026-06-21T10:00:00.000Z');
    const runId = `k_wireless-mouse_${startMs}`;
    const run = findWrite(`workspaces/${UID}/runs/${runId}`);
    expect(run).toBeDefined();
    expect(run.data.runId).toBe(runId);
    expect(run.data.sourceId).toBe('k_wireless-mouse');
    expect(run.data.status).toBe('complete');
    expect(run.data.dayKey).toBe('2026-06-21');
    expect(run.data.counters.placements).toBe(2);
    expect(run.data.counters.uniqueAsins).toBe(2);
    expect(run.data.counters.newSeen).toBe(1);
    expect(run.data.pagesDone).toBe(2);
  });

  test('writes the source spine doc with lastRunId', async () => {
    await syncToCloud(UID, seedBundle());
    const src = findWrite(`workspaces/${UID}/sources/k_wireless-mouse`);
    expect(src).toBeDefined();
    expect(src.data.sourceId).toBe('k_wireless-mouse');
    expect(src.data.type).toBe('keyword');
    expect(src.data.keyword).toBe('wireless mouse');
    expect(src.data.lastRunId).toMatch(/^k_wireless-mouse_/);
  });

  test('returns the expected write tally (2 per product + 2 headers)', async () => {
    const res = await syncToCloud(UID, seedBundle());
    expect(res.products).toBe(2);
    expect(res.written).toBe(2 * 2 + 2); // products*2 + run + source
    // every batch was committed (1 product batch + 1 header batch)
    expect(firestoreMock.__state.committed).toBe(2);
  });

  test('derives a storefront sourceId (s_{sellerId}) from seller meta', async () => {
    const bundle = seedBundle();
    bundle.scrapeRunMeta = {
      type: 'storefront',
      sellerId: 'A123XYZ',
      keyword: null,
      startedAt: '2026-06-21T10:00:00.000Z',
    };
    await syncToCloud(UID, bundle);
    const src = findWrite(`workspaces/${UID}/sources/s_A123XYZ`);
    expect(src).toBeDefined();
    expect(src.data.type).toBe('storefront');
    expect(src.data.sellerId).toBe('A123XYZ');
  });
});
