// Upgrade in place from the live store build (v2.0, commit 7c2ba1c): load it
// unpacked, scrape, then swap the folder to the current build and reload, as
// a Chrome Web Store auto-update does. Based on the audit's upgrade harness.
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  launch, getState, waitForState, sleep, checkoutRevision, copyDir, enableDeveloperMode, BUILD_DIR, EXT_DIR,
} from './lib/extension.mjs';
import { serveAmazon, simplePlan, asinFor } from './lib/amazon.mjs';

const LIVE_REV = '7c2ba1c';
const V20 = path.join(BUILD_DIR, 'v2.0');
const SLOT = path.join(BUILD_DIR, 'upgrade-slot');

function bug(fid, what) {
  test.fail(!process.env.PROSCAN_SHOW_KNOWN, `${fid}: ${what}`);
}

test.beforeAll(() => {
  checkoutRevision(LIVE_REV, V20);
});

/**
 * Starts a v2.0 scrape of `keyword` and waits for `pages` pages, then
 * updates the extension. Returns a page of the updated extension.
 */
async function scrapeThenUpdate(ext, keyword, pages) {
  const v20 = await ext.context.newPage();
  await v20.goto(`chrome-extension://${ext.extId}/popup/popup.html`);
  expect(await v20.evaluate(() => chrome.runtime.getManifest().version)).toBe('2.0');

  const tab = await ext.context.newPage();
  await tab.goto(`https://www.amazon.com/s?k=${keyword}`);
  await sleep(1000);
  // What the v2.0 popup's Start does.
  const started = await v20.evaluate(async (k) => {
    await chrome.storage.local.set({ results: [], currentItemCount: 0, isScrapingActive: true });
    const [t] = await chrome.tabs.query({ url: `*://www.amazon.com/s?k=${k}*` });
    return new Promise((r) => chrome.tabs.sendMessage(t.id, { type: 'START_SCRAPING' }, (resp) => r(resp)));
  }, keyword);
  expect(started).toEqual({ status: 'started' });
  const before = await waitForState(v20, (s) => (s.currentItemCount || 0) >= pages * 4, { timeout: 30000 });

  // The auto-update: new files in the same folder, then a reload.
  await enableDeveloperMode(ext);
  copyDir(EXT_DIR, SLOT);
  await ext.sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await sleep(4000);

  const after = await ext.context.newPage();
  await after.goto(`chrome-extension://${ext.extId}/popup/popup.html`);
  expect(await after.evaluate(() => chrome.runtime.getManifest().version)).toBe('2.1.0');
  return { before, after, tab };
}

test('a v2.0 user keeps their last scrape through the update', async () => {
  copyDir(V20, SLOT);
  const ext = await launch(SLOT);
  try {
    await serveAmazon(ext.context, simplePlan(2));
    const { before, after } = await scrapeThenUpdate(ext, 'mats', 2);
    const s = await waitForState(after, () => true);
    const asins = [1, 2].flatMap((p) => [0, 1, 2, 3].map((i) => asinFor('mats', p, i)));

    expect(before.isScrapingActive).toBe(false);
    expect(s.results.map((r) => r.asin)).toEqual(asins);

    expect(s.schemaVersion).toBe(3);
    expect(Object.keys(s.lastValues || {}).sort()).toEqual([...asins].sort());
  } finally {
    await ext.close();
  }
});

test('a scrape running during the update is stopped, not resumed without a run', async () => {
  copyDir(V20, SLOT);
  const ext = await launch(SLOT);
  try {
    await serveAmazon(ext.context, simplePlan(4));
    const { after } = await scrapeThenUpdate(ext, 'cables', 1);
    await sleep(9000);
    const s = await getState(after);

    expect(s.results.length).toBeGreaterThanOrEqual(4);
    expect(s.schemaVersion).toBe(3);
    expect(s.run).toMatchObject({ runId: 'legacy-2.0', status: 'updated' });

    expect((s.syncQueue || []).filter((p) => !p.runId).map((p) => p.asin)).toEqual([]);
    expect((s.scrapeRunPages || []).filter((p) => !p.runId)).toEqual([]);
  } finally {
    await ext.close();
  }
});
