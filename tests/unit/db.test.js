/**
 * @jest-environment node
 */
require('fake-indexeddb/auto');
const { IDBFactory } = require('fake-indexeddb');
const DB = require('../../scripts/background/db');

let db;
beforeEach(async () => {
  db = await DB.open({ indexedDB: new IDBFactory() });
});
afterEach(() => db.close());

test('opens with every store', () => {
  expect([...db.idb.objectStoreNames].sort()).toEqual(
    ['lastValues', 'meta', 'outbox', 'placements', 'products', 'runs', 'spread']);
});

test('a write is all or nothing', async () => {
  await db.write([{ store: 'runs', put: { runId: 'r1' } }]);
  await expect(db.write([
    { store: 'runs', put: { runId: 'r2' } },
    { store: 'products', put: { runId: 'r2' } }, // no n: the key path fails
  ])).rejects.toMatchObject({ name: 'StorageError' });
  expect((await db.getAll('runs')).map((r) => r.runId)).toEqual(['r1']);
});

test('products come back in the order they were found', async () => {
  await db.write([3, 1, 2].map((n) => ({ store: 'products', put: { runId: 'r1', n, asin: `B0${n}` } })));
  await db.write([{ store: 'products', put: { runId: 'r0', n: 0, asin: 'B0OLD' } }]);
  expect((await db.runProducts('r1')).map((p) => p.asin)).toEqual(['B01', 'B02', 'B03']);
});

test('deleteIndex removes one run and leaves the others', async () => {
  await db.write([
    { store: 'outbox', put: { runId: 'a', asin: '1' } },
    { store: 'outbox', put: { runId: 'b', asin: '2' } },
    { store: 'outbox', put: { runId: 'a', asin: '3' } },
  ]);
  await db.write([{ store: 'outbox', deleteIndex: ['runId', 'a'] }]);
  expect((await db.getAll('outbox')).map((o) => o.asin)).toEqual(['2']);
});

test('meta values round trip', async () => {
  await db.write([{ store: 'meta', put: { key: 'latestRunId', value: 'r9' } }]);
  expect(await db.getMeta('latestRunId')).toBe('r9');
  expect(await db.getMeta('nothing')).toBeUndefined();
});

describe('pruneLastValues', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const day = 86400000;
  const snap = (asin, daysAgo) => ({
    store: 'lastValues',
    put: { asin, priceCents: 100, scrapedAt: daysAgo === null ? null : new Date(now - daysAgo * day).toISOString() },
  });

  test('drops snapshots older than the age limit, keeps undated ones', async () => {
    await db.write([snap('OLD', 400), snap('NEW', 3), snap('UNDATED', null)]);
    expect(await db.pruneLastValues({ max: 10, maxAgeDays: 365, now })).toBe(1);
    expect((await db.getAll('lastValues')).map((s) => s.asin).sort()).toEqual(['NEW', 'UNDATED']);
  });

  test('over the cap, drops undated then the least recently seen', async () => {
    await db.write([snap('A', 1), snap('B', 5), snap('C', 2), snap('U', null), snap('D', 9)]);
    await db.pruneLastValues({ max: 3, maxAgeDays: 365, now });
    expect((await db.getAll('lastValues')).map((s) => s.asin).sort()).toEqual(['A', 'B', 'C']);
  });

  test('under the cap nothing goes', async () => {
    await db.write([snap('A', 1), snap('B', 2)]);
    expect(await db.pruneLastValues({ max: 5, maxAgeDays: 365, now })).toBe(0);
    expect(await db.count('lastValues')).toBe(2);
  });
});

test('a quota error is reported as storage_full', () => {
  const quota = new Error('The quota has been exceeded.');
  quota.name = 'QuotaExceededError';
  expect(DB.storageError(quota).code).toBe('storage_full');
  expect(DB.storageError(new Error('other')).code).toBe('storage_error');
});
