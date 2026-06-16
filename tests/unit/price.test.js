const Price = require('../../scripts/modules/price.js');

describe('price.js', () => {
  describe('priceToCents', () => {
    test('parses "$19.99" -> 1999', () => {
      expect(Price.priceToCents('$19.99')).toBe(1999);
    });

    test('parses "$1,299.00" -> 129900 (thousands separator)', () => {
      expect(Price.priceToCents('$1,299.00')).toBe(129900);
    });

    test('parses a bare number 19.99 -> 1999 (no float drift)', () => {
      expect(Price.priceToCents(19.99)).toBe(1999);
    });

    test('parses whole-dollar "$24" -> 2400', () => {
      expect(Price.priceToCents('$24')).toBe(2400);
    });

    test('returns null for "N/A"', () => {
      expect(Price.priceToCents('N/A')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(Price.priceToCents('')).toBeNull();
    });

    test('returns null for null / undefined', () => {
      expect(Price.priceToCents(null)).toBeNull();
      expect(Price.priceToCents(undefined)).toBeNull();
    });

    test('distinguishes genuine "$0.00" (0) from absent (null)', () => {
      expect(Price.priceToCents('$0.00')).toBe(0);
      expect(Price.priceToCents('N/A')).toBeNull();
    });

    test('handles malformed multi-dot input without NaN', () => {
      // "1.2.3" -> keep first dot only -> "1.23" -> 123
      expect(Price.priceToCents('$1.2.3')).toBe(123);
    });

    test('strips trailing currency text', () => {
      expect(Price.priceToCents('29.99 USD')).toBe(2999);
    });
  });

  describe('centsToDisplay', () => {
    test('formats 1999 -> "$19.99"', () => {
      expect(Price.centsToDisplay(1999)).toBe('$19.99');
    });

    test('formats 0 -> "$0.00"', () => {
      expect(Price.centsToDisplay(0)).toBe('$0.00');
    });

    test('formats negative (delta) -899 -> "-$8.99"', () => {
      expect(Price.centsToDisplay(-899)).toBe('-$8.99');
    });

    test('returns "N/A" for null / NaN', () => {
      expect(Price.centsToDisplay(null)).toBe('N/A');
      expect(Price.centsToDisplay(NaN)).toBe('N/A');
    });
  });

  describe('parsePrice (dollars back-compat shim)', () => {
    test('parses "$19.99" -> 19.99', () => {
      expect(Price.parsePrice('$19.99')).toBe(19.99);
    });

    test('parses "$1,299.00" -> 1299', () => {
      expect(Price.parsePrice('$1,299.00')).toBe(1299);
    });

    test('returns 0 for "N/A" (legacy contract)', () => {
      expect(Price.parsePrice('N/A')).toBe(0);
    });
  });
});
