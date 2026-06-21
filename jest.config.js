module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setup/chrome-mock.js'],
  testMatch: ['**/*.test.js'],
  // sync.js is the one source file authored as ESM (it is bundled into the
  // service worker by esbuild). A tiny scoped transform rewrites its
  // import/export to CommonJS so it can be unit-tested; every other file
  // keeps the default babel-jest transform.
  transform: {
    '[\\\\/]scripts[\\\\/]background[\\\\/]sync\\.js$': '<rootDir>/tests/setup/esm-to-cjs-transform.js',
    '\\.[jt]sx?$': 'babel-jest'
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'scripts/modules/*.js',
    'scripts/content/scraper.js',
    'scripts/content/offer-fetcher.js',
    '!**/node_modules/**'
  ]
};
