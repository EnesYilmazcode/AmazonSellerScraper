const Run = require('../../scripts/lib/run');

const page = (kind, extra = {}) => ({
  kind,
  products: [{ asin: 'B0A' }],
  nextHref: kind === 'results' ? 'https://www.amazon.com/s?k=a&page=2' : null,
  fill: { asin: 1, title: 1, price: 1 },
  ...extra,
});

describe('Run.create', () => {
  test('starts running, bound to its tab', () => {
    const r = Run.create({ runId: 'r1', tabId: 7, maxPages: 5, now: 1000 });
    expect(r).toMatchObject({ runId: 'r1', tabId: 7, status: 'running', page: 0, maxPages: 5, heartbeat: 1000 });
  });

  test.each([[undefined], [0], [-3], ['x'], [2.5]])('maxPages %p falls back to the default', (n) => {
    expect(Run.create({ runId: 'r', tabId: 1, maxPages: n }).maxPages).toBe(Run.DEFAULT_MAX_PAGES);
  });

  test('maxPages is capped', () => {
    expect(Run.clampMaxPages(100000)).toBe(400);
  });
});

describe('Run ownership and staleness', () => {
  const run = Run.create({ runId: 'r1', tabId: 7, now: 1000 });

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
    expect(Run.finish(run, 'blocked', 5000)).toMatchObject({ status: 'blocked', finishedAt: 5000, nextHref: null });
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
    ['empty', 'complete'],
    ['captcha', 'blocked'],
    ['interstitial', 'blocked'],
    ['signin', 'blocked'],
    ['unknown', 'interrupted'],
    ['nonsense', 'selectors_broken'],
  ])('a %s page ends the run as %s', (kind, reason) => {
    expect(Run.outcome(page(kind, kind === 'last' ? {} : { products: [] }), 2, 20)).toBe(reason);
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
    const run = Run.create({ runId: 'r', tabId: 1 });
    expect(Run.describe(Run.finish(run, 'complete'), 3)).toEqual({ text: 'Scraping complete! 3 products found.', type: 'success' });
    for (const reason of ['stopped', 'blocked', 'selectors_broken', 'storage_full', 'interrupted']) {
      expect(Run.describe(Run.finish(run, reason), 3).type).toBe('warning');
    }
    expect(Run.describe(run, 4)).toEqual({ text: 'Scraping in progress... 4 items', type: 'info' });
  });

  test('refusals name the problem', () => {
    expect(Run.refusal('captcha')).toMatch(/captcha/);
    expect(Run.refusal('signin')).toMatch(/sign-in/);
    expect(Run.refusal('unknown')).toMatch(/search or storefront/);
  });
});
