/**
 * @jest-environment node
 */
/**
 * Excel export written and read back with the real SheetJS the popup ships
 * (libs/xlsx.full.min.js), with hostile rows (F-82). Every XML part of the
 * file must parse, which is what Excel needs to open it without a repair.
 */
const AdmZip = require('adm-zip');
const { JSDOM } = require('jsdom');

const { DOMParser } = new JSDOM('').window;

global.XLSX = require('../../libs/xlsx.full.min.js');
global.Analyzer = require('../../scripts/modules/analyzer');
const Exporter = require('../../scripts/modules/exporter');

const product = (over) => ({
  name: 'Plain mat', asin: 'B000000001', price: '$19.99', priceCents: 1999,
  rating: 4.5, reviewCount: 1200, url: 'https://www.amazon.com/dp/B000000001', ...over,
});

const HOSTILE = [
  product(),
  product({ asin: 'B000000002', name: '=HYPERLINK("http://evil.test","x")', price: '$1,299.99', priceCents: 129999 }),
  product({ asin: 'B000000003', name: 'Café Mat™ <b> & "quotes"</b>', rating: null, reviewCount: null }),
  product({ asin: 'B000000004', name: 'ctrl \u0001\u000b\u001f chars', price: null, priceCents: null }),
  product({ asin: 'B000000005', name: 'Zero', rating: 0, reviewCount: 0, priceCents: 0, price: '$0.00' }),
];
const legacy = product({ asin: 'B000000006', price: '$12.99 - $24.99' });
delete legacy.priceCents;
HOSTILE.push(legacy);

function writeBook(results) {
  const report = Analyzer.generateFullReport(results);
  const wb = Exporter.createExcelWorkbook(results, report);
  // The popup writes type 'array' (see exportToExcel).
  return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array', bookSST: false, compression: true }));
}

test('every XML part of the file is well formed', () => {
  const zip = new AdmZip(writeBook(HOSTILE));
  const parts = zip.getEntries().filter((e) => /\.(xml|rels)$/.test(e.entryName));
  expect(parts.map((e) => e.entryName)).toEqual(expect.arrayContaining(['xl/workbook.xml', 'xl/worksheets/sheet1.xml']));
  for (const entry of parts) {
    const doc = new DOMParser().parseFromString(entry.getData().toString('utf8'), 'application/xml');
    expect([entry.entryName, doc.getElementsByTagName('parsererror').length]).toEqual([entry.entryName, 0]);
  }
});

test('markup and entities in a title are escaped once', () => {
  const zip = new AdmZip(writeBook([product({ name: 'A &amp; <B>' })]));
  // SheetJS's reader decodes entities twice, so check the XML itself.
  expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain('A &amp;amp; &lt;B&gt;');
});

test('no cell holds a formula, even for formula-looking titles', () => {
  const zip = new AdmZip(writeBook(HOSTILE));
  zip.getEntries().filter((e) => /worksheets\/.*\.xml$/.test(e.entryName)).forEach((e) => {
    expect(e.getData().toString('utf8')).not.toMatch(/<f[\s>]/);
  });
});

test('the Data sheet reads back with numbers as numbers and unknowns empty', () => {
  const wb = XLSX.read(writeBook(HOSTILE), { type: 'buffer' });
  expect(wb.SheetNames).toEqual(['Data', 'Analytics', 'Insights']);
  const ws = wb.Sheets.Data;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }).slice(8);
  expect(rows.map((r) => r.slice(0, 5))).toEqual([
    ['Plain mat', 'B000000001', 19.99, 4.5, 1200],
    ['=HYPERLINK("http://evil.test","x")', 'B000000002', 1299.99, 4.5, 1200],
    ['Café Mat™ <b> & "quotes"</b>', 'B000000003', 19.99, null, null],
    ['ctrl \u0001\u000b\u001f chars', 'B000000004', null, 4.5, 1200],
    ['Zero', 'B000000005', 0, 0, 0],
    ['Plain mat', 'B000000006', 12.99, 4.5, 1200],
  ]);
  expect(ws.C10.t).toBe('n');
  expect(ws.B10.t).toBe('s');
});

test('the summary averages skip unknown values', () => {
  const wb = XLSX.read(writeBook([product({ priceCents: 1000 }), product({ priceCents: null, price: null, rating: null })]), { type: 'buffer' });
  const ws = wb.Sheets.Data;
  expect(ws.E5.v).toBe(4.5);
  expect(ws.E6.v).toBe(10);
});

test('top opportunities carry numeric price and score', () => {
  const wb = XLSX.read(writeBook(HOSTILE), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Analytics, { header: 1, defval: null });
  const top = rows.slice(rows.findIndex((r) => r[0] === 'Product') + 1).filter((r) => r[0]);
  expect(top.length).toBeGreaterThan(0);
  top.forEach((r) => {
    expect(r[1] === null || typeof r[1] === 'number').toBe(true);
    expect(typeof r[3]).toBe('number');
  });
});
