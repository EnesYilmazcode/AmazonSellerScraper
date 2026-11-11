import { defineConfig } from '@playwright/test';

// One Chromium at a time: every test loads the extension into its own profile.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.mjs',
  globalSetup: './tests/e2e/global-setup.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/.report' }]] : 'list',
  outputDir: 'tests/e2e/.results',
});
