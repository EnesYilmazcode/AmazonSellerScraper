const Delta = require('../../scripts/modules/delta.js');

describe('delta.js', () => {
  describe('computeDeltas', () => {
    test('flags a first-sight ASIN as new with null deltas', () => {
      const current = { priceCents: 1999, rating: 4.5, reviewCount: 100 };
      expect(Delta.computeDeltas(current, null)).toEqual({
        isNew: true, dPriceCents: null, dRating: null, dReviews: null
      });
    });

    test('computes a price drop as a negative cents delta', () => {
      const current = { priceCents: 1799, rating: 4.5, reviewCount: 120 };
      const prev = { priceCents: 1999, rating: 4.5, reviewCount: 100 };
      const d = Delta.computeDeltas(current, prev);
      expect(d.isNew).toBe(false);
      expect(d.dPriceCents).toBe(-200); // $2.00 drop
      expect(d.dReviews).toBe(20);
    });

    test('computes a rating change without float noise', () => {
      const d = Delta.computeDeltas(
        { priceCents: 1000, rating: 4.6, reviewCount: 10 },
        { priceCents: 1000, rating: 4.5, reviewCount: 10 }
      );
      expect(d.dRating).toBe(0.1);
      expect(d.dPriceCents).toBe(0);
      expect(d.dReviews).toBe(0);
    });

    test('yields null deltas when a value is unknown (null priceCents)', () => {
      const d = Delta.computeDeltas(
        { priceCents: null, rating: 4.5, reviewCount: 10 },
        { priceCents: 1999, rating: 4.5, reviewCount: 10 }
      );
      expect(d.dPriceCents).toBeNull();
      expect(d.dRating).toBe(0);
    });
  });

  describe('snapshot', () => {
    test('captures integer cents + run context, nulling unknown numerics', () => {
      const snap = Delta.snapshot({
        priceCents: 2999, rating: 4.2, reviewCount: 50,
        runId: 'r1', scrapedAt: '2026-06-13T00:00:00.000Z'
      });
      expect(snap).toEqual({
        priceCents: 2999, rating: 4.2, reviewCount: 50,
        runId: 'r1', scrapedAt: '2026-06-13T00:00:00.000Z'
      });
    });

    test('nulls a missing/non-numeric priceCents rather than storing 0', () => {
      const snap = Delta.snapshot({ priceCents: null, rating: 4.0, reviewCount: 3 });
      expect(snap.priceCents).toBeNull();
      expect(snap.runId).toBeNull();
    });

    test('a field that failed to parse keeps the last good value and when it was seen (F-29)', () => {
      const first = Delta.snapshot({ priceCents: 2999, rating: 4.2, reviewCount: 50, runId: 'r1', scrapedAt: 'T1' });
      const second = Delta.snapshot({ priceCents: null, rating: 4.3, reviewCount: 51, runId: 'r2', scrapedAt: 'T2' }, first);
      expect(second).toEqual({
        priceCents: 2999, rating: 4.3, reviewCount: 51, runId: 'r2', scrapedAt: 'T2',
        carried: { priceCents: 'T1' }
      });
      const third = Delta.snapshot({ priceCents: null, rating: 4.3, reviewCount: 52, runId: 'r3', scrapedAt: 'T3' }, second);
      expect(third.carried).toEqual({ priceCents: 'T1' });
      const fourth = Delta.snapshot({ priceCents: 2799, rating: 4.3, reviewCount: 52, runId: 'r4', scrapedAt: 'T4' }, third);
      expect(fourth.priceCents).toBe(2799);
      expect(fourth.carried).toBeUndefined();
    });
  });

  describe('prune (F-26)', () => {
    const NOW = Date.parse('2026-09-24T00:00:00Z');
    const at = (daysAgo) => ({ priceCents: 100, rating: 4, reviewCount: 1, runId: 'r',
      scrapedAt: new Date(NOW - daysAgo * 86400000).toISOString() });

    test('keeps a small map as it is', () => {
      const lv = { B01: at(1), B02: at(30) };
      expect(Delta.prune(lv, { now: NOW })).toEqual(lv);
    });

    test('drops snapshots older than the age limit', () => {
      const lv = { NEW: at(10), OLD: at(181) };
      expect(Object.keys(Delta.prune(lv, { now: NOW }))).toEqual(['NEW']);
    });

    test('keeps the most recently seen ASINs past the cap', () => {
      const lv = { A: at(5), B: at(1), C: at(3), D: { priceCents: 1, scrapedAt: null } };
      expect(Object.keys(Delta.prune(lv, { max: 2, now: NOW })).sort()).toEqual(['B', 'C']);
    });

    test('an undated snapshot survives the age limit but goes first at the cap', () => {
      const lv = { U: { priceCents: 1, scrapedAt: null }, A: at(2) };
      expect(Object.keys(Delta.prune(lv, { now: NOW })).sort()).toEqual(['A', 'U']);
      expect(Object.keys(Delta.prune(lv, { max: 1, now: NOW }))).toEqual(['A']);
    });

    test('20,000 ASINs come down to the default cap', () => {
      const lv = {};
      for (let i = 0; i < 20000; i++) lv['B' + String(i).padStart(9, '0')] = at(i % 150);
      const out = Delta.prune(lv, { now: NOW });
      expect(Object.keys(out)).toHaveLength(Delta.MAX_ENTRIES);
      expect(JSON.stringify(out).length).toBeLessThan(1024 * 1024);
    });

    test('handles a missing map', () => {
      expect(Delta.prune(undefined)).toEqual({});
    });
  });
});
