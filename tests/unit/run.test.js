const Run = require('../../scripts/lib/run');

const page = (kind, extra = {}) => ({
  kind,
  products: [{ asin: 'B0A' }],
  nextHref: kind === 'results' ? 'https://www.amazon.com/s?k=a&page=2' : null,
  fill: { asin: 1, title: 1, price: 1 },
  ...extra,
});

const running = (opts) => Run.transition(Run.create(opts), 'running');

describe('Run.create', () => {
  test('starts in starting, bound to its tab', () => {
    const r = Run.create({ runId: 'r1', tabId: 7, maxPages: 5, now: 1000 });
    expect(r).toMatchObject({ runId: 'r1', tabId: 7, state: 'starting', reason: null, page: 0, maxPages: 5, heartbeat: 1000 });
  });

  test.each([[undefined], [0], [-3], ['x'], [2.5]])('maxPages %p falls back to the default', (n) => {
    expect(Run.create({ runId: 'r', tabId: 1, maxPages: n }).maxPages).toBe(Run.DEFAULT_MAX_PAGES);
  });

  test('maxPages is capped', () => {
    expect(Run.clampMaxPages(100000)).toBe(400);
  });
});

describe('the state machine', () => {
  test('no run is idle', () => {
    expect(Run.stateOf(null)).toBe('idle');
    expect(Run.stateOf({ status: 'running' })).toBe('idle');
  });

  test('a run goes starting, running, stopping, stopped', () => {
    let r = Run.create({ runId: 'r', tabId: 1 });
    r = Run.transition(r, 'running');
    r = Run.transition(r, 'stopping');
    r = Run.finish(r, 'stopped', 9);
    expect(r).toMatchObject({ state: 'stopped', reason: 'stopped', finishedAt: 9 });
  });

  test.each(Object.entries(Run.END_STATE))('ending for %s leaves the run %s', (reason, state) => {
    expect(Run.finish(running({ runId: 'r', tabId: 1 }), reason)).toMatchObject({ state, reason });
    expect(Run.isEnded(Run.finish(running({ runId: 'r', tabId: 1 }), reason))).toBe(true);
  });

  test('an ended run cannot be reopened or ended twice', () => {
    const ended = Run.finish(running({ runId: 'r', tabId: 1 }), 'complete');
    expect(() => Run.transition(ended, 'running')).toThrow(/cannot go from done to running/);
    expect(() => Run.finish(ended, 'stopped')).toThrow();
  });

  test('stopping cannot go back to running', () => {
    const r = Run.transition(running({ runId: 'r', tabId: 1 }), 'stopping');
    expect(Run.canTransition('stopping', 'running')).toBe(false);
    expect(() => Run.transition(r, 'running')).toThrow();
  });

  test('every state is known and only live states are active', () => {
    expect(Run.STATES).toEqual(['idle', 'starting', 'running', 'stopping', 'stopped', 'blocked', 'failed', 'done']);
    for (const s of Run.STATES) {
      expect(Run.isActive({ state: s })).toBe(['starting', 'running', 'stopping'].includes(s));
    }
  });
});

describe('Run ownership and staleness', () => {
  const run = running({ runId: 'r1', tabId: 7, now: 1000 });

  test('only the run tab owns a running run', () => {
    expect(Run.owns(run, 7)).toBe(true);
    expect(Run.owns(run, 8)).toBe(false);
    expect(Run.owns(run, null)).toBe(false);
    expect(Run.owns(Run.finish(run, 'stopped'), 7)).toBe(false);
    expect(Run.owns(null, 7)).toBe(false);
  });

  test('a run that has not checked in for a minute is stale', () => {
    expect(Run.isStale(run, 1000 + Run.STALE_MS)).toBe(false);
    expect(Run.isStale(run, 1001 + Run.STALE_MS)).toBe(true);
    expect(Run.isStale(Run.finish(run, 'complete', 2000), 10 ** 12)).toBe(false);
  });

  test('finish records the reason and the time', () => {
    expect(Run.finish(run, 'blocked', 5000)).toMatchObject({ state: 'blocked', reason: 'blocked', finishedAt: 5000, nextHref: null });
  });
});

describe('Run.outcome', () => {
  test('a results page with a next link goes on', () => {
    expect(Run.outcome(page('results'), 1, 20)).toBeNull();
  });

  test('the page cap ends the run as complete', () => {
    expect(Run.outcome(page('results'), 20, 20)).toBe('complete');
  });

  test.each([
    ['last', 'complete'],
    ['empty', 'selectors_broken'],
    ['unreadable', 'selectors_broken'],
    ['captcha', 'blocked'],
    ['interstitial', 'blocked'],
    ['signin', 'blocked'],
    ['unknown', 'interrupted'],
    ['nonsense', 'selectors_broken'],
  ])('a %s page ends the run as %s', (kind, reason) => {
    expect(Run.outcome(page(kind, kind === 'last' ? {} : { products: [] }), 2, 20)).toBe(reason);
  });

  test('"no results" ends the run as complete only on its first page', () => {
    expect(Run.outcome(page('empty', { products: [] }), 1, 20)).toBe('complete');
    expect(Run.outcome(page('empty', { products: [] }), 3, 20)).toBe('selectors_broken');
    expect(Run.outcome(page('unreadable', { products: [] }), 1, 20)).toBe('selectors_broken');
  });

  test('cards that all fail to parse mean the selectors broke, even on the last page', () => {
    expect(Run.outcome(page('results', { products: [] }), 1, 20)).toBe('selectors_broken');
    expect(Run.outcome(page('last', { products: [] }), 1, 20)).toBe('selectors_broken');
    expect(Run.outcome(page('results', { fill: { asin: 1, title: 0, price: 0 } }), 20, 20)).toBe('selectors_broken');
  });

  test('cards with neither titles nor prices mean the selectors broke', () => {
    expect(Run.outcome(page('results', { fill: { asin: 1, title: 0, price: 0.2 } }), 1, 20)).toBe('selectors_broken');
    expect(Run.outcome(page('results', { fill: { asin: 1, title: 1, price: 0.2 } }), 1, 20)).toBeNull();
  });
});

describe('Run text', () => {
  test('page delay is 2 to 4 seconds', () => {
    expect(Run.pageDelay(0)).toBe(2000);
    expect(Run.pageDelay(0.999)).toBeLessThan(4000);
  });

  test('only complete reads as success', () => {
    const run = running({ runId: 'r', tabId: 1 });
    expect(Run.describe(Run.finish(run, 'complete'), 3)).toEqual({ text: 'Scraping complete! 3 products found.', type: 'success' });
    for (const reason of ['stopped', 'blocked', 'selectors_broken', 'storage_full', 'interrupted', 'updated']) {
      expect(Run.describe(Run.finish(run, reason), 3).type).toBe('warning');
    }
    expect(Run.describe(run, 4)).toEqual({ text: 'Scraping in progress... 4 items', type: 'info' });
  });

  test('refusals name the problem', () => {
    expect(Run.refusal('captcha')).toMatch(/captcha/);
    expect(Run.refusal('signin')).toMatch(/sign-in/);
    expect(Run.refusal('unknown')).toMatch(/search or storefront/);
    expect(Run.refusal('unreadable')).toMatch(/could not read/);
  });
});

describe('Run.expects', () => {
  const run = { ...Run.create({ runId: 'r', tabId: 1 }), nextHref: 'https://www.amazon.com/s?k=yoga+mat&page=2&qid=111&ref=sr_pg_1' };

  test('the next page matches, with Amazon rewriting qid and ref', () => {
    expect(Run.expects(run, 'https://www.amazon.com/s?k=yoga+mat&page=2&qid=999&ref=sr_pg_2')).toBe(true);
    expect(Run.expects(run, 'https://www.amazon.com/s/ref=sr_pg_2?k=yoga+mat&page=2')).toBe(true);
  });

  test('a new search, another page or another site does not', () => {
    expect(Run.expects(run, 'https://www.amazon.com/s?k=garden+hose')).toBe(false);
    expect(Run.expects(run, 'https://www.amazon.com/s?k=yoga+mat&page=3')).toBe(false);
    expect(Run.expects(run, 'https://www.amazon.com/s?k=yoga+mat')).toBe(false);
    expect(Run.expects(run, 'https://example.com/s?k=yoga+mat&page=2')).toBe(false);
  });

  test('a run with no next page, or not running, expects nothing', () => {
    expect(Run.expects({ ...run, nextHref: null }, run.nextHref)).toBe(false);
    expect(Run.expects(Run.finish(run, 'complete'), run.nextHref)).toBe(false);
  });
});

describe('Run.sourceOf', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  test('a storefront, a keyword search and junk', () => {
    expect(Run.sourceOf('https://www.amazon.com/s?me=A1B2&k=x', now)).toMatchObject({ type: 'storefront', sellerId: 'A1B2', keyword: null });
    expect(Run.sourceOf('https://www.amazon.com/s?k=yoga+mat', now)).toMatchObject({ type: 'keyword', sellerId: null, keyword: 'yoga mat', startedAt: '2026-09-01T00:00:00.000Z' });
    expect(Run.sourceOf('not a url', now)).toMatchObject({ type: 'keyword', sellerId: null, keyword: null });
  });
});
