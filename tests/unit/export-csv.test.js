/**
 * CSV export read back with a strict RFC 4180 reader (F-70, F-74, F-75).
 */
const { parseCSV } = require('../setup/csv');
const Exporter = require('../../scripts/modules/exporter');

const BOM = '﻿';
const HEADER = ['Product Name', 'ASIN', 'Price (USD)', 'Rating', 'Review Count', 'URL'];

const product = (over) => ({
  name: 'Plain mat', asin: 'B000000001', price: '$19.99', priceCents: 1999,
  rating: 4.5, reviewCount: 1200, url: 'https://www.amazon.com/dp/B000000001', ...over,
});

function readBack(results, spread) {
  const text = Exporter.buildCSV(results, spread);
  expect(text.startsWith(BOM)).toBe(true);
  const rows = parseCSV(text.slice(1));
  rows.forEach((r) => expect(r).toHaveLength(rows[0].length));
  return rows;
}

test('starts with a BOM, uses CRLF and ends with a line break', () => {
  const text = Exporter.buildCSV([product()]);
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text.endsWith('\r\n')).toBe(true);
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
});

test('prices of $1,000 and more stay in one column as numbers (F-70)', () => {
  const rows = readBack([
    product({ asin: 'B000000002', price: '$1,234.00', priceCents: 123400 }),
    product({ asin: 'B000000003', price: '$1,299.99', priceCents: 129999 }),
    product({ asin: 'B000000004', price: '$12,499.50', priceCents: 1249950 }),
  ]);
  expect(rows[0]).toEqual(HEADER);
  expect(rows.slice(1).map((r) => r[2])).toEqual(['1234', '1299.99', '12499.5']);
  expect(rows.slice(1).map((r) => r[5])).toEqual(Array(3).fill('https://www.amazon.com/dp/B000000001'));
});

test('a record with only the display price (from v2.0) still exports its dollars', () => {
  const legacy = product({ price: '$1,299.99' });
  delete legacy.priceCents;
  const euro = product({ price: '€19,99' });
  delete euro.priceCents;
  const rows = readBack([legacy, euro, product({ price: 'N/A', priceCents: undefined })]);
  expect(rows.slice(1).map((r) => r[2])).toEqual(['1299.99', '', '']);
});

test.each(['=HYPERLINK("http://evil.test","x")', '+cmd|\' /C calc\'!A0', '-2+3', '@SUM(A1)', '\tTAB', '\rCR'])(
  'text starting like a formula is neutralised (F-74): %j', (name) => {
    const rows = readBack([product({ name })]);
    expect(rows[1][0]).toBe("'" + name);
  });

test('commas, quotes and line breaks inside text survive the round trip', () => {
  const name = 'Mat, 6mm "Pro"\r\nsecond line';
  const url = 'https://www.amazon.com/dp/B000000001?x="1",y';
  const rows = readBack([product({ name, url })]);
  expect(rows).toHaveLength(2);
  expect(rows[1][0]).toBe(name);
  expect(rows[1][5]).toBe(url);
});

test('non-ASCII text is written as is', () => {
  const rows = readBack([product({ name: 'Café Mat™ – 日本' })]);
  expect(rows[1][0]).toBe('Café Mat™ – 日本');
});

test('unknown values are empty and real zeros stay 0', () => {
  const rows = readBack([
    product({ rating: null, reviewCount: null, priceCents: null, price: null }),
    product({ rating: 0, reviewCount: 0, priceCents: 0, price: '$0.00' }),
  ]);
  expect(rows[1].slice(2, 5)).toEqual(['', '', '']);
  expect(rows[2].slice(2, 5)).toEqual(['0', '0', '0']);
});

test('a missing name or URL is an empty cell, not "undefined"', () => {
  const rows = readBack([{ asin: 'B000000009' }]);
  expect(rows[1]).toEqual(['', 'B000000009', '', '', '', '']);
});

test('negative numbers are numbers, not formula text', () => {
  expect(Exporter.csvCell(-5)).toBe('-5');
  expect(Exporter.csvCell('-5')).toBe('"\'-5"');
});
