module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setup/chrome-mock.js'],
  testMatch: ['**/*.test.js'],
  // Older builds checked out by the e2e upgrade harness have their own tests.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/e2e/\\.build/'],
  modulePathIgnorePatterns: ['<rootDir>/tests/e2e/\\.build/'],
  // sync.js, sync-plan.js, service-worker.js and the shared schema are
  // authored as ESM (esbuild bundles them). A tiny scoped transform
  // rewrites their import/export to CommonJS so they can be unit-tested;
  // every other file keeps the default babel-jest transform.
  transform: {
    '[\\\\/]scripts[\\\\/]background[\\\\/](sync|sync-plan|service-worker)\\.js$': '<rootDir>/tests/setup/esm-to-cjs-transform.js',
    '[\\\\/]packages[\\\\/]schema[\\\\/]index\\.js$': '<rootDir>/tests/setup/esm-to-cjs-transform.js',
    '\\.[jt]sx?$': 'babel-jest'
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'scripts/modules/*.js',
    'scripts/lib/*.js',
    'scripts/content/scraper.js',
    'scripts/content/offer-fetcher.js',
    'packages/schema/index.js',
    '!**/node_modules/**'
  ]
};
