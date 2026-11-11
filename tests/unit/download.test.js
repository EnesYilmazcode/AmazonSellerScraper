/**
 * @jest-environment node
 *
 * DOWNLOAD from the page: the worker makes the file with the popup's
 * Exporter.build and hands it to chrome.downloads, or back to the page
 * when it is too big for a data: URL.
 */
global.XLSX = require('../../libs/xlsx.full.min.js');
global.Analyzer = require('../../scripts/modules/analyzer');
global.SpreadAnalyzer = require('../../scripts/modules/spread-analyzer');
const Exporter = require('../../scripts/modules/exporter');
const Download = require('../../scripts/background/download');

const rows = [
  { name: 'Mat', asin: 'B000000001', price: '$19.99', priceCents: 1999, rating: 4.5, reviewCount: 10, url: 'https://www.amazon.com/dp/B000000001' },
  { name: 'Block', asin: 'B000000002', price: '$9.99', priceCents: 999, rating: 4.1, reviewCount: 3, url: 'https://www.amazon.com/dp/B000000002' },
];
const spread = { B000000001: { sellerPrices: [18, 19.99, 25] } };

function deps(state, max) {
  const calls = [];
  return {
    calls,
    deps: { Exporter, getState: async () => state, download: async (o) => { calls.push(o); return 7; }, max },
  };
}

const decode = (b64) => Buffer.from(b64, 'base64');

test('a small CSV goes to chrome.downloads as a data URL with the save prompt', async () => {
  const { deps: d, calls } = deps({ results: rows, spread });
  const out = await Download.deliver(d, 'csv');
  expect(out).toEqual({ ok: true, via: 'downloads', filename: expect.stringMatching(/\.csv$/) });
  expect(calls).toHaveLength(1);
  expect(calls[0].saveAs).toBe(true);
  expect(calls[0].url.startsWith('data:text/csv;base64,')).toBe(true);
  const text = decode(calls[0].url.split(',')[1]).toString('utf8');
  expect(text.startsWith('﻿"Product Name"')).toBe(true);
  // Spread data rides along now (audit: exports left it out).
  expect(text).toContain('"CV %"');
});

test('Excel from the worker is a real xlsx file', async () => {
  const { deps: d, calls } = deps({ results: rows, spread: {} });
  await Download.deliver(d, 'xlsx');
  expect(calls[0].url.startsWith(`data:${Download.FORMATS.xlsx};base64,`)).toBe(true);
  expect(decode(calls[0].url.split(',')[1]).subarray(0, 2).toString()).toBe('PK');
});

test('a file too big for a data URL goes back to the page', async () => {
  const { deps: d, calls } = deps({ results: rows, spread: {} }, 10);
  const out = await Download.deliver(d, 'json');
  expect(calls).toEqual([]);
  expect(out).toMatchObject({ ok: true, via: 'page', mime: 'application/json', filename: expect.stringMatching(/\.json$/) });
  expect(JSON.parse(decode(out.base64).toString('utf8')).totalProducts).toBe(2);
});

test('nothing to save, or an unknown format, says so', async () => {
  expect(await Download.deliver(deps({ results: [], spread: {} }).deps, 'csv')).toMatchObject({ error: 'empty' });
  expect(await Download.deliver(deps({ results: rows, spread: {} }).deps, 'exe')).toMatchObject({ error: 'format' });
});

test('base64 of a large buffer matches Node', () => {
  const bytes = new Uint8Array(200000).map((_, i) => (i * 31) % 256);
  expect(Download.toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
});
