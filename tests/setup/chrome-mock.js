/**
 * Chrome API mock for testing Chrome extension modules in Node.js/Jest.
 * Loaded via jest.config.js setupFiles — runs before test framework.
 * Uses plain functions (not jest.fn()) since jest globals aren't available yet.
 * Individual tests can override with jest.fn() as needed.
 */

// Polyfill TextEncoder/TextDecoder for jsdom (Node 18+ has them but jest-environment-jsdom may not expose them)
const { TextEncoder, TextDecoder } = require('util');
if (!global.TextEncoder) global.TextEncoder = TextEncoder;
if (!global.TextDecoder) global.TextDecoder = TextDecoder;

let store = {};
// Set by _failNext: the next set() fails with this runtime.lastError message.
let failNext = null;

global.chrome = {
  storage: {
    local: {
      get(keys, callback) {
        const result = {};
        const keyList = keys === null || keys === undefined
          ? Object.keys(store)
          : Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
        keyList.forEach(k => {
          if (store[k] !== undefined) result[k] = store[k];
        });
        if (callback) callback(result);
        return Promise.resolve(result);
      },
      set(data, callback) {
        if (failNext) {
          const message = failNext;
          failNext = null;
          // Like Chrome: a callback sees runtime.lastError, a promise rejects.
          if (!callback) return Promise.reject(new Error(message));
          global.chrome.runtime.lastError = { message };
          try {
            callback();
          } finally {
            global.chrome.runtime.lastError = null;
          }
          return undefined;
        }
        Object.assign(store, data);
        if (callback) callback();
        return Promise.resolve();
      },
      remove(keys, callback) {
        (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]);
        if (callback) callback();
        return Promise.resolve();
      },
      getBytesInUse(keys, callback) {
        const bytes = JSON.stringify(store).length;
        if (callback) callback(bytes);
        return Promise.resolve(bytes);
      },
      QUOTA_BYTES: 10485760,
      _failNext(message = 'QUOTA_BYTES quota exceeded') { failNext = message; },
      clear(callback) {
        store = {};
        if (callback) callback();
        return Promise.resolve();
      },
      _getStore() { return { ...store }; },
      _reset() { store = {}; failNext = null; }
    }
  },
  runtime: {
    sendMessage: function(msg, callback) {
      if (callback) callback({});
    },
    onMessage: {
      addListener: function() {},
      removeListener: function() {}
    },
    getURL: function(path) { return 'chrome-extension://fake-extension-id/' + path; },
    getManifest: function() { return { version: '2.0' }; },
    lastError: null
  },
  tabs: {
    query: function(opts, callback) {
      if (callback) callback([{ id: 1, url: 'https://www.amazon.com/s?k=test' }]);
    },
    sendMessage: function(tabId, msg, callback) {
      if (callback) callback({});
    }
  },
  downloads: {
    download: function(opts, callback) {
      if (callback) callback(12345);
    }
  }
};
