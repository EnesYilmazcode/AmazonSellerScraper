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

global.chrome = {
  storage: {
    local: {
      get(keys, callback) {
        const result = {};
        const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
        keyList.forEach(k => {
          if (store[k] !== undefined) result[k] = store[k];
        });
        if (callback) callback(result);
        return Promise.resolve(result);
      },
      set(data, callback) {
        Object.assign(store, data);
        if (callback) callback();
        return Promise.resolve();
      },
      clear(callback) {
        store = {};
        if (callback) callback();
        return Promise.resolve();
      },
      _getStore() { return { ...store }; },
      _reset() { store = {}; }
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
