// The install warnings Chrome shows for the built manifest, asked of Chrome
// itself. An update that adds a warning disables the extension for every
// user until they re-approve it, so the build may only show fewer.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launch, EXT_DIR } from './lib/extension.mjs';
import { LIVE_MANIFEST } from '../../tools/permission-lock.mjs';

test('the build shows no install warning the live 2.0 build does not', async () => {
  const ext = await launch();
  try {
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extId}/popup/popup.html`);
    const warnings = (manifest) => page.evaluate((m) => new Promise((resolve, reject) => {
      chrome.management.getPermissionWarningsByManifest(m, (w) =>
        chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(w));
    }), JSON.stringify(manifest));

    const live = JSON.parse(fs.readFileSync(LIVE_MANIFEST, 'utf8'));
    const built = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
    const liveWarnings = await warnings(live);
    expect(liveWarnings.length).toBeGreaterThan(0);

    // The check can see an added permission.
    const wider = await warnings({ ...live, permissions: [...live.permissions, 'tabs'] });
    expect(wider.length).toBeGreaterThan(liveWarnings.length);

    const builtWarnings = await warnings(built);
    expect(builtWarnings.filter((w) => !liveWarnings.includes(w))).toEqual([]);
  } finally {
    await ext.close();
  }
});
