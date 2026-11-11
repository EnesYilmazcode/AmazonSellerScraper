// Captures what the live store build (v2.0, commit 7c2ba1c) leaves in
// chrome.storage.local, for the schemaVersion 2 to 3 migration test.
//
// Loads v2.0 unpacked in Chromium, scrapes the saved yoga mat page (real
// Amazon markup, page 1) and a generated last page 2, exactly as the v2.0
// popup's Start does, then writes the storage to
// tests/fixtures/v2.0-storage.json. No request leaves the machine.
//
// Run by hand: node tests/e2e/capture-v20-storage.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitForState, sleep, checkoutRevision, BUILD_DIR } from './lib/extension.mjs';
import { serveAmazon, searchPage, corpusPage } from './lib/amazon.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../fixtures/v2.0-storage.json');
const V20 = path.join(BUILD_DIR, 'v2.0');

checkoutRevision('7c2ba1c', V20);
const ext = await launch(V20);
try {
  await serveAmazon(ext.context, ({ keyword, page }) => {
    if (keyword !== 'yoga mat') return null;
    if (page === 1) return { body: corpusPage('2026-09/search-yoga-mat.html') };
    if (page === 2) return { body: searchPage(keyword, 2, { last: true }) };
    return null;
  });
  const store = await ext.context.newPage();
  await store.goto(`chrome-extension://${ext.extId}/popup/popup.html`);
  const version = await store.evaluate(() => chrome.runtime.getManifest().version);
  if (version !== '2.0') throw new Error(`expected v2.0, got ${version}`);

  const tab = await ext.context.newPage();
  await tab.goto('https://www.amazon.com/s?k=yoga+mat');
  await sleep(1500);
  const started = await store.evaluate(async () => {
    await chrome.storage.local.set({ results: [], currentItemCount: 0, isScrapingActive: true });
    const [t] = await chrome.tabs.query({ url: '*://www.amazon.com/s?k=yoga*' });
    return new Promise((r) => chrome.tabs.sendMessage(t.id, { type: 'START_SCRAPING' }, r));
  });
  if (!started || started.status !== 'started') throw new Error('v2.0 did not start: ' + JSON.stringify(started));

  const s = await waitForState(store, (x) => x.isScrapingActive === false && (x.results || []).length > 0, { timeout: 60000 });
  if (s.isScrapingActive !== false) throw new Error('v2.0 run did not finish');
  fs.writeFileSync(OUT, JSON.stringify(s, null, 2) + '\n');
  console.log(`wrote ${OUT}: keys ${Object.keys(s).join(', ')}, ${s.results.length} results`);
} finally {
  await ext.close();
}
