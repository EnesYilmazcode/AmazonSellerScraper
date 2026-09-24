/**
 * @jest-environment node
 *
 * scripts/background/sync.js over fake-indexeddb and an in-memory Firestore
 * that applies set and mergeFields the way Firestore does. The contract test
 * (tests/contract) runs the same module against the real emulator and rules.
 */
jest.mock('firebase/firestore', () => ({}));

require('fake-indexeddb/auto');
const DB = require('../../scripts/background/db');
const { createSync, isAuthError } = require('../../scripts/background/sync.js');

const START = Date.parse('2026-06-21T10:00:00.000Z');
const RUN_ID = `k_wireless-mouse_${START}`;

/** A tiny Firestore: documents in a Map, keyed by path. */
function fakeFirestore({ failCommit = () => false } = {}) {
  const docs = new Map();
  let commits = 0;
  class FieldPath { constructor(...segs) { this.segs = segs; } }
  const setPath = (obj, segs, value) => {
    let o = obj;
    segs.slice(0, -1).forEach((s) => { o[s] = o[s] && typeof o[s] === 'object' ? o[s] : {}; o = o[s]; });
    o[segs[segs.length - 1]] = value;
  };
  const getPath = (obj, segs) => segs.reduce((o, s) => (o == null ? undefined : o[s]), obj);
  const resolve = (v) => (v && v.__union ? v.__union : v);
  const copy = (v) => (Array.isArray(v) ? v.map(copy)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) : v);
  const fs = {
    doc: (_db, ...path) => ({ path: path.join('/') }),
    getDoc: async (ref) => ({ exists: () => docs.has(ref.path) }),
    Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms, ms }) },
    arrayUnion: (...vals) => ({ __union: vals }),
    FieldPath,
    writeBatch: () => {
      const ops = [];
      return {
        set(ref, data, opts) { ops.push({ ref, data, opts }); },
        async commit() {
          if (failCommit(ops)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
          commits++;
          for (const { ref, data, opts } of ops) {
            if (!opts) { docs.set(ref.path, copy(data)); continue; }
            const cur = docs.get(ref.path) || {};
            for (const f of opts.mergeFields) {
              const segs = f instanceof FieldPath ? f.segs : [f];
              let v = getPath(data, segs);
              if (v && v.__union) v = [...new Set([...(getPath(cur, segs) || []), ...resolve(v)])];
              setPath(cur, segs, copy(v));
            }
            docs.set(ref.path, cur);
          }
        },
      };
    },
  };
  return { fs, docs, commits: () => commits };
}

let dbCount = 0;
async function storeWith({ products = 3, perPage = 2, uid = 'u1', state = 'running' } = {}) {
  const store = await DB.open({ name: `sync-test-${++dbCount}` });
  const pages = Math.ceil(products / perPage);
  const ops = [{
    store: 'runs',
    put: {
      runId: RUN_ID, sourceId: 'k_wireless-mouse', dayKey: '2026-06-21', state, reason: state === 'done' ? 'complete' : null,
      source: { type: 'keyword', sellerId: null, keyword: 'wireless mouse', url: 'https://www.amazon.com/s?k=wireless+mouse' },
      startedAt: START, finishedAt: state === 'done' ? START + 1000 : null, page: pages, maxPages: 20,
    },
  }];
  for (let n = 0; n < products; n++) {
    const page = Math.floor(n / perPage) + 1;
    ops.push({
      store: 'products',
      put: {
        runId: RUN_ID, n, pageIndex: page, asin: `B0${String(n).padStart(8, '0')}`, name: `Mouse ${n}`,
        priceCents: 1000 + n, rating: 4.5, reviewCount: 10, isPrime: true, sponsored: false, organicRank: n + 1,
        scrapedAt: new Date(START + n).toISOString(), placements: [{ page, position: 1, sponsored: false, rank: n + 1 }],
        delta: { isNew: true, dPriceCents: null, dRating: null, dReviews: null }, prev: null,
      },
    });
  }
  for (let page = 1; page <= pages; page++) {
    ops.push({ store: 'placements', put: { runId: RUN_ID, pageIndex: page, count: perPage, placements: perPage, kind: 'results', scrapedAt: new Date(START).toISOString(), total: products } });
    ops.push({ store: 'outbox', put: { runId: RUN_ID, kind: 'page', pageIndex: page, uid, queuedAt: START } });
  }
  if (state === 'done') ops.push({ store: 'outbox', put: { runId: RUN_ID, kind: 'run', uid, queuedAt: START } });
  await store.write(ops);
  return store;
}

const quiet = { warn() {}, log() {}, error() {} };

test('a flush writes every queued page and empties the outbox', async () => {
  const store = await storeWith({ products: 3, perPage: 2, state: 'done' });
  const cloud = fakeFirestore();
  const sync = createSync({ db: {}, openStore: async () => store, fs: cloud.fs, log: quiet });
  const totals = await sync.flush('u1');
  // page 1: chunk + 2x2 + run + source; page 2: chunk + 1x2 + run + source; end: run + source
  expect(totals).toEqual({ entries: 3, pages: 2, runs: 1, products: 3, writes: 7 + 5 + 2 });
  expect(await store.count('outbox')).toBe(0);
  const run = cloud.docs.get(`workspaces/u1/runs/${RUN_ID}`);
  expect(run).toMatchObject({ status: 'complete', pagesDone: 2, pagesPlanned: 2, counters: { uniqueAsins: 3 } });
  expect(cloud.docs.get('workspaces/u1/products/B000000002').sourceIds).toEqual(['k_wireless-mouse']);
  expect(cloud.docs.has(`workspaces/u1/runs/${RUN_ID}/pages/p0002`)).toBe(true);
  expect(cloud.docs.get('workspaces/u1/sources/k_wireless-mouse')).toMatchObject({ lastRunId: RUN_ID, catalogSize: 3 });
});

test('a new product gets firstSeenAt, and a second flush never moves it (F-29b)', async () => {
  const store = await storeWith({ products: 1, perPage: 1 });
  const cloud = fakeFirestore();
  const sync = createSync({ db: {}, openStore: async () => store, fs: cloud.fs, log: quiet });
  await sync.flush('u1');
  const first = cloud.docs.get('workspaces/u1/products/B000000000');
  expect(first.firstSeenAt.ms).toBe(START);
  expect(first.firstRunId).toBe(RUN_ID);

  // The same product again, as after a reinstall: new locally, known in the cloud.
  cloud.docs.get('workspaces/u1/products/B000000000').firstSeenAt = { ms: 1, toMillis: () => 1 };
  await store.write([{ store: 'outbox', put: { runId: RUN_ID, kind: 'page', pageIndex: 1, uid: 'u1', queuedAt: START } }]);
  await sync.flush('u1');
  expect(cloud.docs.get('workspaces/u1/products/B000000000').firstSeenAt.ms).toBe(1);
});

test('an entry leaves the outbox only after its own commit (F-22)', async () => {
  const store = await storeWith({ products: 4, perPage: 2 });
  let calls = 0;
  const cloud = fakeFirestore({ failCommit: () => ++calls === 2 });
  const sync = createSync({ db: {}, openStore: async () => store, fs: cloud.fs, log: quiet });
  await expect(sync.flush('u1')).rejects.toMatchObject({ code: 'unavailable' });
  expect((await store.getAll('outbox')).map((e) => e.pageIndex)).toEqual([2]);
  await sync.flush('u1');
  expect(await store.count('outbox')).toBe(0);
  expect(cloud.docs.has(`workspaces/u1/runs/${RUN_ID}/pages/p0002`)).toBe(true);
});

test('a page queued during a flush is written before it returns (F-22)', async () => {
  const store = await storeWith({ products: 2, perPage: 2 });
  const cloud = fakeFirestore();
  let appended = false;
  const onBatch = async () => {
    if (appended) return;
    appended = true;
    await store.write([
      { store: 'products', put: { runId: RUN_ID, n: 2, pageIndex: 2, asin: 'B0LATE0001', priceCents: 5, isPrime: false, placements: [{ page: 2, position: 1, sponsored: false, rank: 3 }], delta: { isNew: true }, prev: null, scrapedAt: new Date(START).toISOString() } },
      { store: 'placements', put: { runId: RUN_ID, pageIndex: 2, count: 1, placements: 1, kind: 'last', scrapedAt: new Date(START).toISOString() } },
      { store: 'outbox', put: { runId: RUN_ID, kind: 'page', pageIndex: 2, uid: 'u1', queuedAt: START } },
    ]);
  };
  const sync = createSync({ db: {}, openStore: async () => store, fs: cloud.fs, onBatch, log: quiet });
  const totals = await sync.flush('u1');
  expect(totals.pages).toBe(2);
  expect(await store.count('outbox')).toBe(0);
  expect(cloud.docs.get('workspaces/u1/products/B0LATE0001').latest.p).toBe(5);
});

test('a second flush while one runs waits for it and does not write twice', async () => {
  const store = await storeWith({ products: 2, perPage: 1 });
  const cloud = fakeFirestore();
  const sync = createSync({ db: {}, openStore: async () => store, fs: cloud.fs, log: quiet });
  const [a, b] = await Promise.all([sync.flush('u1'), sync.flush('u1')]);
  expect(a).toBe(b);
  expect(a.pages).toBe(2);
  expect(cloud.commits()).toBe(2);
});

test('entries of another account are left alone (F-29e)', async () => {
  const store = await storeWith({ products: 2, perPage: 2, uid: 'someone-else' });
  const cloud = fakeFirestore();
  const sync = createSync({ db: {}, openStore: async () => store, fs: cloud.fs, log: quiet });
  expect(await sync.pending('u1')).toBe(0);
  expect(await sync.flush('u1')).toMatchObject({ entries: 0, writes: 0 });
  expect(cloud.docs.size).toBe(0);
  expect(await sync.pending('someone-else')).toBe(1);
  expect(await sync.flush(null)).toMatchObject({ entries: 0 });
});

test('big pages are split into batches under the Firestore limit', async () => {
  const store = await storeWith({ products: 60, perPage: 60 });
  const cloud = fakeFirestore();
  const sizes = [];
  const sync = createSync({ db: {}, openStore: async () => store, fs: cloud.fs, batchLimit: 50, onBatch: async ({ writes }) => sizes.push(writes), log: quiet });
  const totals = await sync.flush('u1');
  expect(totals.writes).toBe(1 + 120 + 2);
  expect(sizes).toEqual([50, 50, 23]);
});

test('an entry whose run is gone is dropped', async () => {
  const store = await DB.open({ name: `sync-test-${++dbCount}` });
  await store.write([{ store: 'outbox', put: { runId: 'gone', kind: 'page', pageIndex: 1, uid: 'u1' } }]);
  const sync = createSync({ db: {}, openStore: async () => store, fs: fakeFirestore().fs, log: quiet });
  expect(await sync.flush('u1')).toMatchObject({ entries: 1, pages: 0 });
  expect(await store.count('outbox')).toBe(0);
});

test('auth errors are told apart from network errors', () => {
  expect(isAuthError({ code: 'permission-denied' })).toBe(true);
  expect(isAuthError({ code: 'auth/user-token-expired' })).toBe(true);
  expect(isAuthError({ code: 'unavailable' })).toBe(false);
  expect(isAuthError(null)).toBe(false);
});
