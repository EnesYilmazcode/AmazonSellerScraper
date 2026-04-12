const { sampleProducts, sampleSpreadResults } = require('../fixtures/sample-products');

// Mock XLSX global before loading Exporter
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

// Mock URL.createObjectURL / revokeObjectURL
global.URL.createObjectURL = jest.fn(() => 'blob:fake-url');
global.URL.revokeObjectURL = jest.fn();

// Make Analyzer available for exportToJSON
global.Analyzer = require('../../scripts/modules/analyzer');

const Exporter = require('../../scripts/modules/exporter');

describe('Exporter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chrome.runtime.lastError = null;
  });

  // ── getFileName ─────────────────────────────────────────────
  describe('getFileName', () => {
    test('generates filename with date and format extension', () => {
      const name = Exporter.getFileName(sampleProducts, 'xlsx');
      expect(name).toMatch(/amazon_store_scraped_data_\d{4}-\d{2}-\d{2}\.xlsx/);
    });

    test('defaults to xlsx extension', () => {
      const name = Exporter.getFileName(sampleProducts);
      expect(name).toEndWith('.xlsx');
    });

    test('uses csv extension when specified', () => {
      const name = Exporter.getFileName(sampleProducts, 'csv');
      expect(name).toEndWith('.csv');
    });

    test('uses json extension when specified', () => {
      const name = Exporter.getFileName(sampleProducts, 'json');
      expect(name).toEndWith('.json');
    });

    test('defaults to "amazon_store" when no sellerName', () => {
      const name = Exporter.getFileName(sampleProducts);
      expect(name).toContain('amazon_store');
    });

    test('sanitizes special characters in seller name', () => {
      const products = [{ sellerName: 'Test Store! @#$' }];
      const name = Exporter.getFileName(products);
      expect(name).not.toMatch(/[!@#$]/);
    });
  });

  // ── exportToCSV ─────────────────────────────────────────────
  describe('exportToCSV', () => {
    test('returns blob and filename', () => {
      const result = Exporter.exportToCSV(sampleProducts);
      expect(result).toHaveProperty('blob');
      expect(result).toHaveProperty('filename');
      expect(result.filename).toEndWith('.csv');
    });

    test('CSV blob has correct MIME type', () => {
      const result = Exporter.exportToCSV(sampleProducts);
      expect(result.blob.type).toBe('text/csv;charset=utf-8;');
    });

    test('includes spread columns when spreadResults provided', () => {
      global.SpreadAnalyzer = require('../../scripts/modules/spread-analyzer');
      const result = Exporter.exportToCSV(sampleProducts, sampleSpreadResults);
      expect(result).toHaveProperty('blob');
      delete global.SpreadAnalyzer;
    });

    test('handles empty results array', () => {
      const result = Exporter.exportToCSV([]);
      expect(result).toHaveProperty('blob');
      expect(result).toHaveProperty('filename');
    });
  });

  // ── exportToJSON ────────────────────────────────────────────
  describe('exportToJSON', () => {
    test('returns blob and filename', () => {
      const result = Exporter.exportToJSON(sampleProducts);
      expect(result).toHaveProperty('blob');
      expect(result.filename).toEndWith('.json');
    });

    test('includes products array', () => {
      const result = Exporter.exportToJSON(sampleProducts, false);
      expect(result.blob.type).toBe('application/json');
    });

    test('includes analytics when Analyzer is available', () => {
      const result = Exporter.exportToJSON(sampleProducts, true);
      expect(result).toHaveProperty('blob');
    });

    test('works without analytics', () => {
      const result = Exporter.exportToJSON(sampleProducts, false);
      expect(result).toHaveProperty('blob');
    });
  });

  // ── createExcelWorkbook ─────────────────────────────────────
  describe('createExcelWorkbook', () => {
    test('creates workbook with Data and Analytics sheets', () => {
      const wb = Exporter.createExcelWorkbook(sampleProducts);
      expect(wb.SheetNames).toContain('Data');
      expect(wb.SheetNames).toContain('Analytics');
    });

    test('adds Insights sheet when analysisReport has insights', () => {
      const report = Analyzer.generateFullReport(sampleProducts);
      const wb = Exporter.createExcelWorkbook(sampleProducts, report);
      expect(wb.SheetNames).toContain('Insights');
    });

    test('omits Insights sheet when no analysisReport', () => {
      const wb = Exporter.createExcelWorkbook(sampleProducts, null);
      expect(wb.SheetNames).not.toContain('Insights');
    });
  });

  // ── exportToExcel ───────────────────────────────────────────
  describe('exportToExcel', () => {
    test('returns blob and filename', () => {
      const result = Exporter.exportToExcel(sampleProducts);
      expect(result).toHaveProperty('blob');
      expect(result.filename).toEndWith('.xlsx');
    });

    test('calls XLSX.write with correct options', () => {
      Exporter.exportToExcel(sampleProducts);
      expect(XLSX.write).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          bookType: 'xlsx',
          type: 'array'
        })
      );
    });
  });

  // ── triggerDownload ─────────────────────────────────────────
  describe('triggerDownload', () => {
    test('calls chrome.downloads.download with correct params', () => {
      chrome.downloads.download = jest.fn((opts, cb) => cb(123));
      const blob = new Blob(['test'], { type: 'text/plain' });
      const callback = jest.fn();

      Exporter.triggerDownload(blob, 'test.csv', callback);

      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'test.csv',
          saveAs: true
        }),
        expect.any(Function)
      );
    });

    test('calls URL.revokeObjectURL after download', () => {
      chrome.downloads.download = jest.fn((opts, cb) => cb(123));
      const blob = new Blob(['test'], { type: 'text/plain' });

      Exporter.triggerDownload(blob, 'test.csv');

      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });

    test('passes downloadId to callback on success', () => {
      chrome.downloads.download = jest.fn((opts, cb) => cb(456));
      chrome.runtime.lastError = null;
      const callback = jest.fn();
      const blob = new Blob(['test'], { type: 'text/plain' });

      Exporter.triggerDownload(blob, 'test.csv', callback);

      expect(callback).toHaveBeenCalledWith(456);
    });

    test('passes null to callback on error', () => {
      chrome.downloads.download = jest.fn((opts, cb) => {
        chrome.runtime.lastError = { message: 'download failed' };
        cb(undefined);
      });
      const callback = jest.fn();
      const blob = new Blob(['test'], { type: 'text/plain' });

      Exporter.triggerDownload(blob, 'test.csv', callback);

      expect(callback).toHaveBeenCalledWith(null);
    });
  });

  // Custom matcher
  expect.extend({
    toEndWith(received, suffix) {
      const pass = typeof received === 'string' && received.endsWith(suffix);
      return {
        pass,
        message: () => `expected "${received}" to end with "${suffix}"`
      };
    }
  });
});
