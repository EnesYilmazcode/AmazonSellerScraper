// The sync contract: the real engine fills IndexedDB (fake-indexeddb), the
// real sync module drains it into the Firestore emulator, and the dashboard
// repo's firestore.rules judge every write. Run through tools/contract.mjs,
// which starts the emulators.
//
// Queue sizes 1, 201 and 600, a page appended in the middle of a flush,
// replace semantics across runs, create-only firstSeenAt, a write count
// per run, a product in two sources, and an entry the rules refuse.

import 'fake-indexeddb/auto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  initializeFirestore, connectFirestoreEmulator, doc, getDoc, collection, getCountFromServer, terminate,
} from 'firebase/firestore';
import { createSync, isAuthError } from '../../scripts/background/sync.js';
import * as Schema from '../../packages/schema/index.js';

const require = createRequire(import.meta.url);
const DB = require('../../scripts/background/db.js');
const { createEngine } = require('../../scripts/background/engine.js');

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) throw new Error('run through tools/contract.mjs, which starts the emulators');

const app = initializeApp({ projectId: 'demo-proscan', apiKey: 'demo-key' });
const auth = getAuth(app);
const db = initializeFirestore(app, {});
connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
connectFirestoreEmulator(db, FS_HOST.split(':')[0], Number(FS_HOST.split(':')[1]));

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 86400000;
let dbSeq = 0;

function memoryArea(init = {}) {
  let data = JSON.parse(JSON.stringify(init));
  return {
    async get(keys) {
      const list = keys == null ? Object.keys(data) : [].concat(keys);
      return Object.fromEntries(list.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
    },
    async set(items) { Object.assign(data, JSON.parse(JSON.stringify(items))); },
    async remove(keys) { [].concat(keys).forEach((k) => delete data[k]); },
  };
}

/** The real engine over a fresh IndexedDB, with a tab that always answers. */
function extension(uid) {
  const name = `contract-${process.pid}-${++dbSeq}`;
  const clock = { t: 0 };
  let url = '';
  const chrome = {
    storage: { session: memoryArea(), local: memoryArea({ account: { uid }, settings: { maxPages: 400 } }) },
    runtime: { lastError: null },
    tabs: {
      sendMessage(tabId, message, opts, cb) {
        setImmediate(() => cb(message.type === 'PING' ? { ok: true, kind: 'results', url } : { ok: true }));
      },
      async update() { return {}; },
      async get(id) { return { id, url }; },
    },
  };
  const engine = createEngine({
    chrome, openDb: () => DB.open({ name }), now: () => clock.t, random: () => 0,
    setTimer: () => 0, clearTimer: () => {}, flags: { CLOUD_SYNC: true }, log: quiet,
  });
  const sender = { tab: { id: 1 } };

  /** Starts a keyword run at `startMs`, or a run on `at` when given. */
  async function start(keyword, startMs, at = null) {
    clock.t = startMs;
    url = at || `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`;
    const resp = await engine.start({ tabId: 1 });
    assert.equal(resp.ok, true, JSON.stringify(resp));
    return resp.runId;
  }

  /** Reports page `page` of the live run; `last` ends the run. */
  async function page(runId, pageNo, products, { last = false, total = 0 } = {}) {
    if (pageNo > 1) {
      clock.t += 5000;
      await engine.tick();
    }
    const result = {
      kind: last ? 'last' : 'results',
      products: products.map((p) => ({ ...p, scrapedAt: new Date(clock.t).toISOString() })),
      placements: products.length,
      nextHref: last ? null : `${url}&page=${pageNo + 1}`,
      total,
      fill: { asin: 1, title: 1, price: 1 },
    };
    const resp = await engine.pageResult({ runId, page: pageNo, url: pageNo === 1 ? url : `${url}&page=${pageNo}`, result }, sender);
    assert.equal(resp.ok, true, JSON.stringify(resp));
  }

  /** A whole run of `products`, `perPage` to a page. */
  async function scrape(keyword, startMs, products, perPage, at = null) {
    const runId = await start(keyword, startMs, at);
    const pages = Math.ceil(products.length / perPage);
    for (let i = 0; i < pages; i++) {
      await page(runId, i + 1, products.slice(i * perPage, (i + 1) * perPage), { last: i === pages - 1, total: products.length });
    }
    return runId;
  }

  const sync = (opts = {}) => createSync({ db, openStore: () => engine.db(), log: quiet, ...opts });
  return { engine, start, page, scrape, sync, store: () => engine.db() };
}

const asinOf = (i) => `B0${i.toString(36).toUpperCase().padStart(8, '0')}`;
function products(n, { price = (i) => 1000 + i } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const cents = price(i);
    return {
      asin: asinOf(i), name: `Product ${i}`, price: cents === null ? null : `$${(cents / 100).toFixed(2)}`,
      priceCents: cents, currency: cents === null ? null : 'USD', rating: 4.5, reviewCount: 100 + i, isPrime: i % 2 === 0,
      sponsored: false, url: `https://www.amazon.com/dp/${asinOf(i)}`,
      img: `https://m.media-amazon.com/images/I/${i}.jpg`,
      placements: [{ position: 1, sponsored: false, rank: 1 }],
    };
  });
}

/**
 * Writes a run takes: per page the chunk and 2 per product (document and
 * history); the header and source once per flush round the run had entries in.
 */
const expectedWrites = (pageSizes, rounds = 1) => pageSizes.reduce((n, k) => n + 1 + 2 * k, 0) + 2 * rounds;

async function account(email) {
  const cred = await createUserWithEmailAndPassword(auth, email, 'contract-pass-1');
  return cred.user.uid;
}

const ws = (uid, ...rest) => doc(db, 'workspaces', uid, ...rest);
const count = async (uid, ...path) => (await getCountFromServer(collection(db, 'workspaces', uid, ...path))).data().count;

before(async () => {
  const rules = process.env.PROSCAN_CONTRACT_RULES || '(unknown)';
  console.log(`# rules: ${rules}`);
});

after(async () => {
  await signOut(auth).catch(() => {});
  await terminate(db).catch(() => {});
  await deleteApp(app).catch(() => {});
});

test('queue size 1: one product on one page', async () => {
  const uid = await account(`one-${Date.now()}@contract.test`);
  const ext = extension(uid);
  const start = Date.parse('2026-06-09T14:00:00Z');
  const runId = await ext.scrape('single mug', start, products(1), 60);
  assert.equal(runId, `k_single-mug_${start}`);

  const totals = await ext.sync().flush(uid);
  assert.deepEqual(totals, { entries: 2, pages: 1, runs: 1, products: 1, writes: expectedWrites([1]), failed: 0 });
  assert.equal(await (await ext.store()).count('outbox'), 0);

  const p = (await getDoc(ws(uid, 'products', asinOf(0)))).data();
  assert.deepEqual(Schema.validateProduct({ ...p }), []);
  assert.equal(p.latest.p, 1000);
  assert.equal(p.latest.runId, runId);
  assert.equal(p.firstRunId, runId);
  assert.equal(p.img, 'https://m.media-amazon.com/images/I/0.jpg');
  const run = (await getDoc(ws(uid, 'runs', runId))).data();
  assert.deepEqual(Schema.validateRun(run), []);
  assert.equal(run.status, 'complete');
  assert.equal(run.pagesPlanned, 1);
  const chunk = (await getDoc(ws(uid, 'runs', runId, 'pages', 'p0001'))).data();
  assert.deepEqual(Schema.validatePage(chunk), []);
  assert.deepEqual(Object.keys(chunk.items), [asinOf(0)]);
  const hist = (await getDoc(ws(uid, 'products', asinOf(0), 'history', 'daily'))).data();
  assert.deepEqual(Schema.validateHistory(hist), []);
  const src = (await getDoc(ws(uid, 'sources', 'k_single-mug'))).data();
  assert.deepEqual(Schema.validateSource(src), []);
  assert.equal(src.lastRunId, runId);
});

test('queue size 201, with a page appended in the middle of the flush', async () => {
  const uid = await account(`mid-${Date.now()}@contract.test`);
  const ext = extension(uid);
  const all = products(201);
  const start = Date.parse('2026-06-10T09:00:00Z');
  const runId = await ext.start('yoga mat', start);
  for (let i = 0; i < 4; i++) await ext.page(runId, i + 1, all.slice(i * 48, (i + 1) * 48), { total: 201 });

  let appended = false;
  const sync = ext.sync({
    onBatch: async () => {
      if (appended) return;
      appended = true;
      // The last page lands while page 1 is being written.
      await ext.page(runId, 5, all.slice(192), { last: true, total: 201 });
    },
  });
  const totals = await sync.flush(uid);
  assert.equal(appended, true);
  assert.equal(totals.pages, 5);
  assert.equal(totals.products, 201);
  assert.equal(totals.writes, expectedWrites([48, 48, 48, 48, 9], 2));
  assert.equal(await (await ext.store()).count('outbox'), 0);

  assert.equal(await count(uid, 'products'), 201);
  assert.equal(await count(uid, 'runs', runId, 'pages'), 5);
  const run = (await getDoc(ws(uid, 'runs', runId))).data();
  assert.equal(run.status, 'complete');
  assert.equal(run.pagesDone, 5);
  assert.equal(run.counters.uniqueAsins, 201);
  assert.equal(run.totalResultsOnSerp, 201);
  const last = (await getDoc(ws(uid, 'products', asinOf(200)))).data();
  assert.equal(last.latest.p, 1200);
});

test('queue size 600: two runs a week apart replace latest and delta, and keep firstSeenAt', async () => {
  const uid = await account(`six-${Date.now()}@contract.test`);
  const ext = extension(uid);
  const day1 = Date.parse('2026-06-01T15:00:00Z');
  const day8 = day1 + 7 * DAY;
  const run1 = await ext.scrape('garden hose', day1, products(300), 60);
  // Week two: every 10th price fails to parse, the rest drop by 100 cents.
  const run2 = await ext.scrape('garden hose', day8, products(300, { price: (i) => (i % 10 === 0 ? null : 900 + i) }), 60);

  const totals = await ext.sync().flush(uid);
  assert.equal(totals.pages, 10);
  assert.equal(totals.runs, 2);
  assert.equal(totals.products, 600);
  assert.equal(totals.writes, 2 * expectedWrites([60, 60, 60, 60, 60]));
  assert.equal(await count(uid, 'products'), 300);

  const failed = (await getDoc(ws(uid, 'products', asinOf(10)))).data();
  assert.equal(failed.latest.runId, run2);
  assert.equal('p' in failed.latest, false, 'a price that failed to parse is not last week\'s price (F-21)');
  assert.equal('p' in (failed.delta || {}), false, 'no price delta without a price (F-21)');
  assert.equal(failed.firstRunId, run1);

  const moved = (await getDoc(ws(uid, 'products', asinOf(11)))).data();
  assert.equal(moved.latest.p, 911);
  assert.equal(moved.prev.p, 1011);
  assert.deepEqual(moved.delta, { p: -100, pPct: -9.9, r: 0, v: 0, days: 7 });
  assert.equal(moved.firstRunId, run1);
  assert.equal(moved.firstSeenAt.toMillis(), day1);

  const hist = (await getDoc(ws(uid, 'products', asinOf(11), 'history', 'daily'))).data();
  assert.deepEqual(Object.keys(hist.d).sort(), [Schema.dayKeyOf(day1, new Date(day1).getTimezoneOffset()), Schema.dayKeyOf(day8, new Date(day8).getTimezoneOffset())].sort());

  for (const runId of [run1, run2]) {
    const run = (await getDoc(ws(uid, 'runs', runId))).data();
    assert.equal(run.status, 'complete');
    assert.equal(run.sourceId, 'k_garden-hose');
    assert.equal(await count(uid, 'runs', runId, 'pages'), 5);
  }
  assert.equal((await getDoc(ws(uid, 'runs', run1))).data().counters.newSeen, 300);
  assert.equal((await getDoc(ws(uid, 'runs', run2))).data().counters.newSeen, 0);
  assert.equal((await getDoc(ws(uid, 'sources', 'k_garden-hose'))).data().lastRunId, run2);
});

test('a reinstall does not move firstSeenAt (F-29b)', async () => {
  const uid = await account(`re-${Date.now()}@contract.test`);
  const first = extension(uid);
  const day1 = Date.parse('2026-05-01T12:00:00Z');
  const run1 = await first.scrape('desk lamp', day1, products(5), 60);
  await first.sync().flush(uid);

  // A fresh install on another computer: no lastValues, every product looks new.
  const second = extension(uid);
  await second.scrape('desk lamp', day1 + 30 * DAY, products(5), 60);
  await second.sync().flush(uid);

  const p = (await getDoc(ws(uid, 'products', asinOf(3)))).data();
  assert.equal(p.firstRunId, run1);
  assert.equal(p.firstSeenAt.toMillis(), day1);
});

test('another account cannot write this account\'s queue, and the entries stay', async () => {
  const owner = await account(`a-${Date.now()}@contract.test`);
  const ext = extension(owner);
  await ext.scrape('phone case', Date.parse('2026-06-12T10:00:00Z'), products(3), 60);
  await signOut(auth);
  await account(`b-${Date.now()}@contract.test`);

  await assert.rejects(ext.sync().flush(owner), (err) => err.code === 'permission-denied' && !isAuthError(err));
  assert.equal(await (await ext.store()).count('outbox'), 2);
});

test('a product seen by a storefront and a keyword run lists both sources (NEW-SYNC-1)', async () => {
  const uid = await account(`two-${Date.now()}@contract.test`);
  const ext = extension(uid);
  const day = Date.parse('2026-06-14T10:00:00Z');
  await ext.scrape('store', day, products(6), 60, 'https://www.amazon.com/s?me=A3K9XELT4QZ6M2');
  await ext.sync().flush(uid);
  // The keyword run sees the first 3 again.
  await ext.scrape('water bottle', day + 60000, products(3), 60);
  await ext.sync().flush(uid);

  const both = (await getDoc(ws(uid, 'products', asinOf(1)))).data();
  assert.deepEqual([...both.sourceIds].sort(), ['k_water-bottle', 's_A3K9XELT4QZ6M2']);
  const one = (await getDoc(ws(uid, 'products', asinOf(5)))).data();
  assert.deepEqual(one.sourceIds, ['s_A3K9XELT4QZ6M2']);
});

test('an entry the rules refuse is set aside and the next scan still syncs (EXT9-1)', async () => {
  const uid = await account(`skew-${Date.now()}@contract.test`);
  const ext = extension(uid);
  // A clock two hours fast: the rules refuse times over an hour ahead.
  const ahead = Date.now() + 2 * 60 * 60 * 1000;
  const bad = await ext.scrape('fast clock', ahead, products(2), 60);
  // Other ASINs: these would carry the fast clock in prev.at.
  const good = await ext.scrape('garden hose', Date.now() - 60000, products(4).slice(2), 60);

  const totals = await ext.sync().flush(uid);
  assert.equal(totals.failed, 2);
  assert.equal((await getDoc(ws(uid, 'runs', good))).exists(), true);
  assert.equal((await getDoc(ws(uid, 'runs', bad))).exists(), false);
  const sync = ext.sync();
  assert.equal(await sync.pending(uid), 0);
  assert.equal(await sync.failed(uid), 2);
});
