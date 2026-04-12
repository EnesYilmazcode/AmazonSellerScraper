/**
 * DOM helpers for testing content scripts that don't export their functions.
 * Uses Node's vm module to execute script files in a JSDOM context,
 * making all file-scoped functions accessible for testing.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

/**
 * Load a content script into a JSDOM context with Chrome API mocks.
 * Returns the context object so tests can call the script's functions.
 *
 * @param {string} scriptPath - Relative path from project root to the script file
 * @param {string} html - HTML content to load into the DOM
 * @param {string} [url='https://www.amazon.com/s?k=test&page=1'] - Page URL
 * @returns {Object} VM context with all script functions accessible
 */
function loadContentScript(scriptPath, html, url = 'https://www.amazon.com/s?k=test&page=1') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });

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
    JSON: global.JSON
  });

  const absolutePath = path.resolve(__dirname, '../../', scriptPath);
  const code = fs.readFileSync(absolutePath, 'utf8');

  vm.runInContext(code, context);

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

module.exports = { loadContentScript, wrapHTML };
