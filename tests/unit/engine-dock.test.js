/**
 * @jest-environment node
 *
 * The dock's messages to the run engine: a run started from the page is
 * bound to the page's own tab, RUN_STATUS gives the run in brief and never
 * the products or the key, and the run's tab hears about each saved page.
 */
const { createRig, settle } = require('../setup/engine-rig');
const { summarize, brief } = require('../../scripts/background/engine');
const Run = require('../../scripts/lib/run');

const asinFor = (k, p, i) => `B0${k.slice(0, 3).toUpperCase().padEnd(3, 'X')}${String(p).padStart(2, '0')}${String(i).padStart(3, '0')}`;
const card = (asin, price) => `
  <div class="s-result-item" data-asin="${asin}" data-component-type="s-search-result">
    <a href="/dp/${asin}"><h2><span>Item ${asin}</span></h2></a>
    <div class="a-price" data-a-size="xl"><span class="a-offscreen">${price}</span></div>
    <div data-cy="reviews-ratings-slot"><span class="a-icon-alt">4.5 out of 5 stars</span></div>
  </div>`;
const pageNo = (url) => Number(new URL(url).searchParams.get('page') || 1);
function site(pages) {
  return (url) => {
    const u = new URL(url);
    const k = u.searchParams.get('k') || u.searchParams.get('me');
    const p = pageNo(url);
    if (!k || p > pages) return null;
    const cards = [0, 1, 2, 3].map((i) => card(asinFor(k, p, i), `$${10 + i}.00`)).join('');
    const q = u.searchParams.get('me') ? `me=${k}` : `k=${k}`;
    const next = p < pages
      ? `<a class="s-pagination-next" href="/s?${q}&page=${p + 1}">Next</a>`
      : '<span class="s-pagination-next s-pagination-disabled">Next</span>';
    return `<!DOCTYPE html><html><body><div class="s-main-slot">${cards}</div>${next}</body></html>`;
  };
}

async function runUntilEnd(rig, ms = 30000) {
  for (let t = 0; t < ms; t += 500) {
    const run = await rig.run();
    if (run && !Run.isActive(run)) return run;
    await settle(500);
  }
  return rig.run();
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('START_RUN_HERE runs in the sender tab, whatever tab id the message names', async () => {
  const rig = createRig({ site: site(2) });
  const other = rig.openTab('https://www.amazon.com/s?k=other');
  const tab = rig.openTab('https://www.amazon.com/s?k=here');
  await settle();
  const resp = await rig.tab(tab, { type: 'START_RUN_HERE', tabId: other });
  expect(resp).toMatchObject({ ok: true });
  expect((await rig.run()).tabId).toBe(tab);
  const run = await runUntilEnd(rig);
  expect(run).toMatchObject({ state: 'done', reason: 'complete', page: 2, itemCount: 8 });
});

test('a page count sent with Scrape becomes the setting and caps the run', async () => {
  const rig = createRig({ site: site(5), local: { settings: { maxPages: 20 } } });
  const tab = rig.openTab('https://www.amazon.com/s?me=A1B2C3D4E5F6G7');
  await settle();
  await rig.tab(tab, { type: 'START_RUN_HERE', maxPages: 2 });
  const run = await runUntilEnd(rig);
  expect(run).toMatchObject({ reason: 'complete', page: 2, maxPages: 2 });
  expect(rig.local.dump().settings.maxPages).toBe(2);
  expect(run.source).toMatchObject({ type: 'storefront', sellerId: 'A1B2C3D4E5F6G7' });
});

test('the popup-only START_RUN is still refused from a page', async () => {
  const rig = createRig({ site: site(2) });
  const tab = rig.openTab('https://www.amazon.com/s?k=nope');
  await settle();
  expect(await rig.tab(tab, { type: 'START_RUN', tabId: tab })).toBeNull();
  expect(await rig.run()).toBeNull();
});

test('RUN_STATUS says whose run it is and leaves out products and the key', async () => {
  const rig = createRig({ site: site(3), local: { geminiApiKey: 'AIzaSECRETSECRETSECRET00', account: { uid: 'u1', email: 'a@b.c' } } });
  const tab = rig.openTab('https://www.amazon.com/s?k=mine');
  const other = rig.openTab('https://www.amazon.com/s?k=theirs');
  await settle();
  await rig.tab(tab, { type: 'START_RUN_HERE' });
  await settle(100);

  const mine = await rig.tab(tab, { type: 'RUN_STATUS' });
  const theirs = await rig.tab(other, { type: 'RUN_STATUS' });
  expect(mine.run).toMatchObject({ state: 'running', thisTab: true, maxPages: 20 });
  expect(theirs.run).toMatchObject({ state: 'running', thisTab: false });
  expect(mine).toMatchObject({ hasKey: true, signedIn: true, settings: { maxPages: 20, suggest: true } });
  const text = JSON.stringify(mine);
  expect(text).not.toMatch(/SECRET|a@b\.c|B0MIN/);
  expect(mine.run).not.toHaveProperty('tabId');

  const run = await runUntilEnd(rig);
  const done = await rig.tab(tab, { type: 'RUN_STATUS' });
  expect(done.run).toMatchObject({ runId: run.runId, state: 'done', reason: 'complete', page: 3, thisTab: true });
  expect(done.count).toBe(12);
  expect(done.summary).toEqual({ medianCents: 1150, avgRating: 4.5, sponsoredPct: 0 });
  expect(JSON.stringify(done)).not.toMatch(/B0MIN/);
});

test('STOP_RUN_HERE stops the run and keeps what it saved', async () => {
  const rig = createRig({ site: site(4) });
  const tab = rig.openTab('https://www.amazon.com/s?k=halt');
  await settle();
  await rig.tab(tab, { type: 'START_RUN_HERE' });
  await settle(200);
  expect((await rig.run()).page).toBe(1);
  expect(await rig.tab(tab, { type: 'STOP_RUN_HERE' })).toMatchObject({ ok: true, stopped: true });
  expect(await rig.run()).toMatchObject({ state: 'stopped', reason: 'stopped', itemCount: 4 });
});

test('the run tab hears about every saved page it waits on', async () => {
  const rig = createRig({ site: site(3) });
  const tab = rig.openTab('https://www.amazon.com/s?k=news');
  await settle();
  await rig.tab(tab, { type: 'START_RUN_HERE' });
  await runUntilEnd(rig);
  const progress = rig.toTab(tab).filter((m) => m.type === 'RUN_PROGRESS');
  expect(progress.map((m) => [m.page, m.itemCount, m.maxPages])).toEqual([[1, 4, 20], [2, 8, 20]]);
  expect(rig.toTab(tab).some((m) => m.type === 'RUN_ENDED')).toBe(true);
});

test('SAVE_SETTINGS clamps the page count and keeps other settings', async () => {
  const rig = createRig({ site: site(1), local: { settings: { maxPages: 20, pageDelay: 2000 } } });
  const tab = rig.openTab('https://www.amazon.com/s?k=cfg');
  await settle();
  expect(await rig.tab(tab, { type: 'SAVE_SETTINGS', maxPages: 9999, suggest: false }))
    .toMatchObject({ settings: { maxPages: 400, suggest: false } });
  expect(rig.local.dump().settings).toEqual({ maxPages: 400, pageDelay: 2000, suggest: false });
  await rig.tab(tab, { type: 'SAVE_SETTINGS', maxPages: 'x' });
  expect(rig.local.dump().settings.maxPages).toBe(Run.DEFAULT_MAX_PAGES);
});

describe('summarize', () => {
  test('median price, average rating and sponsored share', () => {
    expect(summarize([
      { priceCents: 1000, rating: 4, sponsored: true },
      { priceCents: 3000, rating: 5 },
      { priceCents: null, rating: null },
      { priceCents: 2000 },
    ])).toEqual({ medianCents: 2000, avgRating: 4.5, sponsoredPct: 25 });
  });
  test('nothing known gives nulls', () => {
    expect(summarize([])).toEqual({ medianCents: null, avgRating: null, sponsoredPct: null });
  });
});

test('brief keeps the run shape small', () => {
  const run = { runId: 'r', tabId: 3, state: 'running', page: 2, maxPages: 10, itemCount: 5, source: { type: 'keyword', keyword: 'x', url: 'u' } };
  expect(brief(run, 3)).toEqual({
    runId: 'r', state: 'running', reason: null, page: 2, maxPages: 10, itemCount: 5, startedAt: null, finishedAt: null,
    source: { type: 'keyword', sellerId: null, keyword: 'x' }, thisTab: true,
  });
  expect(brief(null, 3)).toBeNull();
});
