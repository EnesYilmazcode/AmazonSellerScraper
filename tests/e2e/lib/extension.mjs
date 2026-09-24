// Loads an unpacked build into Chromium and drives it the way a user does:
// through the real popup page.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILD_DIR = path.resolve(HERE, '../.build');
export const EXT_DIR = path.join(BUILD_DIR, 'ext');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launches Chromium with `extDir` loaded, in a fresh profile. Extensions need
 * the full Chromium build, so this uses channel "chromium" (new headless).
 * PROSCAN_CHROMIUM points at another binary when the pinned one is missing.
 */
export async function launch(extDir = EXT_DIR) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'proscan-e2e-'));
  const opts = {
    headless: process.env.HEADED ? false : true,
    viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  };
  if (process.env.PROSCAN_CHROMIUM) opts.executablePath = process.env.PROSCAN_CHROMIUM;
  else opts.channel = 'chromium';
  const context = await chromium.launchPersistentContext(profile, opts);
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const close = async () => {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { context, sw, extId, close };
}

/** An extension page used to read and write chrome.storage. */
export async function extPage(ext) {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extId}/popup/popup.html`);
  return page;
}

export async function getState(page) {
  return page.evaluate(() => chrome.storage.local.get(null));
}

/**
 * Opens the real popup in a tab, points its active-tab query at `tab`, and
 * clicks the main button. Returns the popup page.
 */
export async function clickStart(ext, tab) {
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extId}/popup/popup.html`);
  await aimPopupAt(popup, tab);
  await popup.click('#actionButton');
  return popup;
}

export async function aimPopupAt(popup, tab) {
  const url = tab.url();
  await popup.evaluate((target) => {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q, cb) => orig({}, (tabs) => {
      const hit = tabs.filter((t) => t.url === target);
      return cb ? cb(hit) : hit;
    });
  }, url);
}

/** Polls until fn(state) is truthy or the timeout passes; returns the last state. */
export async function waitForState(page, fn, { timeout = 20000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  let state = await getState(page);
  while (!fn(state) && Date.now() < end) {
    await sleep(interval);
    state = await getState(page);
  }
  return state;
}

/**
 * How the run ended, as the user is told. Today the popup says "complete"
 * whenever the flag is off. When the rebuild stores a real end reason,
 * read it here and nowhere else.
 */
export function endReason(state) {
  if (state.scrapeEndReason) return state.scrapeEndReason;
  if (state.run && state.run.status) return state.run.status;
  return state.isScrapingActive ? 'running' : 'complete';
}

/** The source a run was recorded under, or null. */
export function runMetaFor(state, runId) {
  if (state.scrapeRuns && state.scrapeRuns[runId]) return state.scrapeRuns[runId];
  if (state.scrapeRunId === runId) return state.scrapeRunMeta || null;
  return null;
}

/** Service worker target ids, via CDP on `page`. */
export async function workerTargets(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'service_worker').map((t) => t.targetId);
}

/**
 * Stops the extension's service worker the way Chrome does when idle.
 * Resolves to true once the old worker is gone (a new one may already be up).
 */
export async function killServiceWorker(ext, page) {
  const cdp = await ext.context.newCDPSession(page);
  const old = await workerTargets(cdp);
  for (const targetId of old) await cdp.send('Target.closeTarget', { targetId });
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const now = await workerTargets(cdp);
    if (old.length > 0 && !old.some((id) => now.includes(id))) return true;
    await sleep(100);
  }
  return false;
}

/** Writes the tree of git revision `rev` into `dir`, without touching the index. */
export function checkoutRevision(rev, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const index = path.join(os.tmpdir(), `proscan-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const root = path.resolve(HERE, '../../..');
  execFileSync('git', ['read-tree', rev], { cwd: root, env });
  execFileSync('git', ['checkout-index', '-a', `--prefix=${dir.split(path.sep).join('/')}/`], { cwd: root, env });
  fs.rmSync(index, { force: true });
}

export function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

/**
 * Turns developer mode on. A fresh profile has it off, and then reloading an
 * unpacked extension from new files disables it (unsupportedDeveloperExtension).
 */
export async function enableDeveloperMode(ext) {
  const page = await ext.context.newPage();
  await page.goto('chrome://extensions');
  await page.evaluate(() => new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));
  await page.close();
}
