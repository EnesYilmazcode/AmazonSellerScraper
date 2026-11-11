// Chrome mock is loaded via setupFiles
const Storage = require('../../scripts/modules/storage');

describe('Storage', () => {
  beforeEach(() => {
    chrome.storage.local._reset();
  });

  // ── KEYS ────────────────────────────────────────────────────
  describe('KEYS', () => {
    test('has all expected key constants', () => {
      expect(Storage.KEYS.RESULTS).toBe('results');
      expect(Storage.KEYS.ITEM_COUNT).toBe('currentItemCount');
      expect(Storage.KEYS.IS_SCRAPING).toBe('isScrapingActive');
      expect(Storage.KEYS.SETTINGS).toBe('settings');
      expect(Storage.KEYS.SPREAD_RESULTS).toBe('spreadResults');
      expect(Storage.KEYS.IS_SPREAD_ANALYZING).toBe('isSpreadAnalyzing');
    });
  });

  // ── get / set ───────────────────────────────────────────────
  describe('get / set', () => {
    test('set then get returns the value', async () => {
      await Storage.set('testKey', 'testValue');
      const result = await Storage.get('testKey');
      expect(result).toBe('testValue');
    });

    test('get returns undefined for missing key', async () => {
      const result = await Storage.get('nonexistent');
      expect(result).toBeUndefined();
    });

    test('set overwrites existing value', async () => {
      await Storage.set('key', 'first');
      await Storage.set('key', 'second');
      const result = await Storage.get('key');
      expect(result).toBe('second');
    });

    test('stores objects correctly', async () => {
      const obj = { name: 'test', items: [1, 2, 3] };
      await Storage.set('data', obj);
      const result = await Storage.get('data');
      expect(result).toEqual(obj);
    });
  });

  // ── getMultiple / setMultiple ───────────────────────────────
  describe('getMultiple / setMultiple', () => {
    test('sets and retrieves multiple keys atomically', async () => {
      await Storage.setMultiple({ a: 1, b: 2, c: 3 });
      const result = await Storage.getMultiple(['a', 'b', 'c']);
      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });

    test('getMultiple returns only existing keys', async () => {
      await Storage.set('exists', true);
      const result = await Storage.getMultiple(['exists', 'missing']);
      expect(result).toEqual({ exists: true });
    });
  });

  // ── clear ───────────────────────────────────────────────────
  describe('clear', () => {
    test('removes all stored data', async () => {
      await Storage.setMultiple({ a: 1, b: 2 });
      await Storage.clear();
      const a = await Storage.get('a');
      const b = await Storage.get('b');
      expect(a).toBeUndefined();
      expect(b).toBeUndefined();
    });
  });

  // ── getScrapingState ────────────────────────────────────────
  describe('getScrapingState', () => {
    test('returns defaults when storage is empty', async () => {
      const state = await Storage.getScrapingState();
      expect(state.isActive).toBe(false);
      expect(state.itemCount).toBe(0);
      expect(state.results).toEqual([]);
    });

    test('returns stored values when populated', async () => {
      await Storage.setMultiple({
        isScrapingActive: true,
        currentItemCount: 42,
        results: [{ asin: 'B001' }]
      });
      const state = await Storage.getScrapingState();
      expect(state.isActive).toBe(true);
      expect(state.itemCount).toBe(42);
      expect(state.results).toEqual([{ asin: 'B001' }]);
    });
  });

  // ── resetForNewScrape ───────────────────────────────────────
  describe('resetForNewScrape', () => {
    test('clears results, sets count to 0, sets isScrapingActive to true', async () => {
      // Pre-populate with old data
      await Storage.setMultiple({
        results: [{ asin: 'old' }],
        currentItemCount: 99,
        isScrapingActive: false
      });

      await Storage.resetForNewScrape();

      const state = await Storage.getScrapingState();
      expect(state.results).toEqual([]);
      expect(state.itemCount).toBe(0);
      expect(state.isActive).toBe(true);
    });

    test('clears stale spreadResults and isSpreadAnalyzing flag', async () => {
      // A fresh scrape must not inherit the prior run's spread map, or
      // insights/exports would surface stale per-ASIN spread numbers.
      await Storage.setMultiple({
        spreadResults: { B001: { sellerPrices: [10, 20] } },
        isSpreadAnalyzing: true
      });

      await Storage.resetForNewScrape();

      const spread = await Storage.get(Storage.KEYS.SPREAD_RESULTS);
      const analyzing = await Storage.get(Storage.KEYS.IS_SPREAD_ANALYZING);
      expect(spread).toEqual({});
      expect(analyzing).toBe(false);
    });
  });

  // ── beginRun ─────────────────────────────────────────────────
  describe('beginRun', () => {
    test('mints a run id and resets per-run bookkeeping', async () => {
      const runId = await Storage.beginRun('https://www.amazon.com/s?me=A123XYZ&page=1');
      expect(typeof runId).toBe('string');
      expect(runId.length).toBeGreaterThan(0);
      expect(await Storage.get(Storage.KEYS.SCRAPE_RUN_ID)).toBe(runId);
      expect(await Storage.get(Storage.KEYS.RUN_PAGE_INDEX)).toBe(0);
      expect(await Storage.get(Storage.KEYS.RUN_PAGES)).toEqual([]);
    });

    test('detects a storefront source from the me= param', async () => {
      await Storage.beginRun('https://www.amazon.com/s?me=A123XYZ');
      const meta = await Storage.get(Storage.KEYS.RUN_META);
      expect(meta.type).toBe('storefront');
      expect(meta.sellerId).toBe('A123XYZ');
      expect(meta.keyword).toBeNull();
    });

    test('detects a keyword source from the k= param', async () => {
      await Storage.beginRun('https://www.amazon.com/s?k=wireless+mouse');
      const meta = await Storage.get(Storage.KEYS.RUN_META);
      expect(meta.type).toBe('keyword');
      expect(meta.keyword).toBe('wireless mouse');
      expect(meta.sellerId).toBeNull();
    });

    test('does NOT clear the durable sync queue or lastValues', async () => {
      await Storage.setMultiple({
        syncQueue: [{ asin: 'B001' }],
        lastValues: { B001: { priceCents: 1000 } }
      });
      await Storage.beginRun('https://www.amazon.com/s?k=x');
      expect(await Storage.get(Storage.KEYS.SYNC_QUEUE)).toEqual([{ asin: 'B001' }]);
      expect(await Storage.get(Storage.KEYS.LAST_VALUES)).toEqual({ B001: { priceCents: 1000 } });
    });
  });

  // ── appendResults ───────────────────────────────────────────
  describe('appendResults', () => {
    test('appends to existing results and updates count', async () => {
      await Storage.set('results', [{ asin: 'B001' }]);
      const count = await Storage.appendResults([{ asin: 'B002' }, { asin: 'B003' }]);
      expect(count).toBe(3);

      const results = await Storage.getResults();
      expect(results.length).toBe(3);
    });

    test('works from empty (first page)', async () => {
      const count = await Storage.appendResults([{ asin: 'B001' }]);
      expect(count).toBe(1);
    });

    test('returns new total count', async () => {
      await Storage.appendResults([{ asin: 'A' }]);
      const count = await Storage.appendResults([{ asin: 'B' }]);
      expect(count).toBe(2);
    });
  });

  // ── completeScraping ────────────────────────────────────────
  describe('completeScraping', () => {
    test('sets isScrapingActive to false and updates count', async () => {
      await Storage.set('isScrapingActive', true);
      await Storage.completeScraping(50);

      const isActive = await Storage.get('isScrapingActive');
      const count = await Storage.get('currentItemCount');
      expect(isActive).toBe(false);
      expect(count).toBe(50);
    });
  });

  // ── getResults ──────────────────────────────────────────────
  describe('getResults', () => {
    test('returns stored results array', async () => {
      await Storage.set('results', [{ asin: 'B001' }, { asin: 'B002' }]);
      const results = await Storage.getResults();
      expect(results.length).toBe(2);
    });

    test('returns empty array when no results stored', async () => {
      const results = await Storage.getResults();
      expect(results).toEqual([]);
    });
  });

  // ── write errors and quota (F-26) ───────────────────────────
  describe('write errors', () => {
    test('a quota error rejects with code storage_full', async () => {
      chrome.storage.local._failNext('QUOTA_BYTES quota exceeded');
      await expect(Storage.set('results', [1])).rejects.toMatchObject({
        name: 'StorageError', code: 'storage_full'
      });
      expect(await Storage.get('results')).toBeUndefined();
    });

    test('any other error rejects with code storage_error', async () => {
      chrome.storage.local._failNext('IO error: .../LOCK: File currently in use.');
      await expect(Storage.setMultiple({ a: 1 })).rejects.toMatchObject({ code: 'storage_error' });
    });

    test('resetForNewScrape fails loudly instead of resolving', async () => {
      chrome.storage.local._failNext();
      await expect(Storage.resetForNewScrape()).rejects.toMatchObject({ code: 'storage_full' });
    });

    test('lastError is cleared again after the failed call', async () => {
      chrome.storage.local._failNext();
      await Storage.set('a', 1).catch(() => {});
      await Storage.set('b', 2);
      expect(await Storage.get('b')).toBe(2);
      expect(chrome.runtime.lastError).toBeNull();
    });
  });

  describe('usage', () => {
    test('reports bytes against the quota', async () => {
      await Storage.set('results', [{ asin: 'B001' }]);
      const u = await Storage.usage();
      expect(u.quota).toBe(10485760);
      expect(u.bytes).toBeGreaterThan(0);
      expect(u.nearFull).toBe(false);
    });

    test('is near full from 90% of the quota', async () => {
      const orig = chrome.storage.local.getBytesInUse;
      chrome.storage.local.getBytesInUse = (keys, cb) => cb(Math.ceil(10485760 * 0.9));
      try {
        expect((await Storage.usage()).nearFull).toBe(true);
      } finally {
        chrome.storage.local.getBytesInUse = orig;
      }
    });
  });

  describe('remove', () => {
    test('removes the given keys only', async () => {
      await Storage.setMultiple({ a: 1, b: 2, c: 3 });
      await Storage.remove(['a', 'b']);
      expect(chrome.storage.local._getStore()).toEqual({ c: 3 });
    });
  });
});
