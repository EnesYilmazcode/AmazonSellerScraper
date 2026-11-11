/**
 * DOM helpers for testing content scripts that don't export their functions.
 * Uses Node's vm module to execute script files in a JSDOM context,
 * making all file-scoped functions accessible for testing.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

// Real Amazon pages carry CSS jsdom cannot parse; keep that out of test output.
function quietConsole() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    if (!/Could not parse CSS stylesheet/.test(err.message)) console.error(err);
  });
  return vc;
}

/**
 * Load a content script into a JSDOM context with Chrome API mocks.
 * Returns the context object so tests can call the script's functions.
 *
 * @param {string} scriptPath - Relative path from project root to the script file
 * @param {string} html - HTML content to load into the DOM
 * @param {string} [url='https://www.amazon.com/s?k=test&page=1'] - Page URL
 * @param {Object} [options]
 * @param {Object} [options.flags] - Overrides for scripts/lib/flags.js, e.g. { CLOUD_SYNC: true }
 * @param {Object} [options.globals] - Replaces context globals, e.g. a per-tab chrome and timers
 * @returns {Object} VM context with all script functions accessible
 */
function loadContentScript(scriptPath, html, url = 'https://www.amazon.com/s?k=test&page=1', options = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', virtualConsole: quietConsole() });

  // Polyfill innerText (JSDOM doesn't implement it)
  if (!dom.window.HTMLElement.prototype.hasOwnProperty('innerText')) {
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      get() { return this.textContent; },
      set(value) { this.textContent = value; },
      configurable: true
    });
  }

  const context = vm.createContext({
    ...dom.window,
    document: dom.window.document,
    window: dom.window,
    navigator: dom.window.navigator,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement,
    DOMParser: dom.window.DOMParser,
    URL: dom.window.URL || global.URL,
    Blob: dom.window.Blob || global.Blob,
    chrome: global.chrome,
    console: {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    },
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    fetch: jest.fn(),
    Promise: global.Promise,
    Set: global.Set,
    Map: global.Map,
    Array: global.Array,
    Object: global.Object,
    Math: global.Math,
    Date: global.Date,
    parseInt: global.parseInt,
    parseFloat: global.parseFloat,
    isNaN: global.isNaN,
    RegExp: global.RegExp,
    String: global.String,
    Number: global.Number,
    JSON: global.JSON,
    ...(options.globals || {})
  });

  const absolutePath = path.resolve(__dirname, '../../', scriptPath);

  // Pre-load shared content-modules (Price, Parsers, Delta) into the SAME script scope
  // so content scripts can reference them as globals — mirroring how the
  // manifest lists them before their consumers at runtime. Top-level `const`
  // declarations share one lexical environment only within a single
  // runInContext call, so they are concatenated ahead of the target script.
  let preamble = '';
  for (const rel of ['scripts/modules/price.js', 'scripts/lib/parsers.js', 'scripts/lib/messages.js', 'scripts/lib/run.js', 'scripts/lib/flags.js', 'scripts/modules/delta.js']) {
    const dep = path.resolve(__dirname, '../../', rel);
    if (fs.existsSync(dep)) preamble += fs.readFileSync(dep, 'utf8') + '\n';
  }
  if (options.flags) preamble += `Object.assign(Flags, ${JSON.stringify(options.flags)});
`;
  const code = fs.readFileSync(absolutePath, 'utf8');

  vm.runInContext(preamble + code, context);

  // Attach the DOM for later manipulation
  context._dom = dom;
  context._document = dom.window.document;

  return context;
}

/**
 * Create a minimal HTML document from a fragment string.
 * Wraps the fragment in a basic HTML structure.
 */
function wrapHTML(bodyContent) {
  return `<!DOCTYPE html><html><head></head><body>${bodyContent}</body></html>`;
}

module.exports = { loadContentScript, wrapHTML, quietConsole };
