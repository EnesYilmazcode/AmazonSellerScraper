module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setup/chrome-mock.js'],
  testMatch: ['**/*.test.js'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'scripts/modules/*.js',
    'scripts/content/scraper.js',
    'scripts/content/offer-fetcher.js',
    '!**/node_modules/**'
  ]
};
