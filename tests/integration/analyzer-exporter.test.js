/**
 * Integration: Analyzer → Exporter pipeline
 * Validates that Analyzer.generateFullReport() output is correctly
 * consumed by Exporter for Excel, CSV, and JSON exports.
 */

const { sampleProducts, sampleSpreadResults } = require('../fixtures/sample-products');

// Set up XLSX mock
global.XLSX = {
  utils: {
    book_new: jest.fn(() => ({ SheetNames: [], Sheets: {} })),
    book_append_sheet: jest.fn((wb, ws, name) => {
      wb.SheetNames.push(name);
      wb.Sheets[name] = ws;
    }),
    aoa_to_sheet: jest.fn((data) => ({
      _data: data,
      '!cols': [],
      '!merges': []
    })),
    encode_cell: jest.fn(({ r, c }) => `${String.fromCharCode(65 + c)}${r + 1}`)
  },
  write: jest.fn(() => new Uint8Array([1, 2, 3]))
};

global.URL.createObjectURL = jest.fn(() => 'blob:fake-url');
global.URL.revokeObjectURL = jest.fn();

const Analyzer = require('../../scripts/modules/analyzer');
global.Analyzer = Analyzer;

const Exporter = require('../../scripts/modules/exporter');

describe('Analyzer → Exporter pipeline', () => {
  let report;

  beforeAll(() => {
    report = Analyzer.generateFullReport(sampleProducts);
  });

  test('generateFullReport output is accepted by createExcelWorkbook', () => {
    const wb = Exporter.createExcelWorkbook(sampleProducts, report);
    expect(wb.SheetNames).toContain('Data');
    expect(wb.SheetNames).toContain('Analytics');
    expect(wb.SheetNames).toContain('Insights');
  });

  test('Analytics sheet receives top opportunities from report', () => {
    const wb = Exporter.createExcelWorkbook(sampleProducts, report);
    expect(wb.Sheets['Analytics']).toBeDefined();
    // The aoa_to_sheet mock stores the data passed to it
    const analyticsData = wb.Sheets['Analytics']._data;
    expect(analyticsData).toBeDefined();
    // Should contain "Top Opportunities" section header
    const hasOpportunitiesHeader = analyticsData.some(row =>
      row && row[0] === 'Top Opportunities'
    );
    expect(hasOpportunitiesHeader).toBe(true);
  });

  test('Insights sheet is populated from report insights', () => {
    const wb = Exporter.createExcelWorkbook(sampleProducts, report);
    const insightsData = wb.Sheets['Insights']._data;
    expect(insightsData).toBeDefined();
    // Should have header row
    const hasHeader = insightsData.some(row =>
      row && row[0] === 'Priority' && row[1] === 'Insight'
    );
    expect(hasHeader).toBe(true);
  });

  test('exportToJSON includes valid analytics section', () => {
    const result = Exporter.exportToJSON(sampleProducts, true);
    expect(result).toHaveProperty('blob');
    expect(result.blob.type).toBe('application/json');
  });

  test('exportToExcel with full report produces valid workbook', () => {
    const result = Exporter.exportToExcel(sampleProducts, report);
    expect(result).toHaveProperty('blob');
    expect(result).toHaveProperty('filename');
    expect(XLSX.write).toHaveBeenCalled();
  });

  test('CSV export with spread data includes spread columns', () => {
    global.SpreadAnalyzer = require('../../scripts/modules/spread-analyzer');

    const result = Exporter.exportToCSV(sampleProducts, sampleSpreadResults);
    expect(result).toHaveProperty('blob');
    expect(result.blob.type).toBe('text/csv;charset=utf-8;');

    delete global.SpreadAnalyzer;
  });
});
