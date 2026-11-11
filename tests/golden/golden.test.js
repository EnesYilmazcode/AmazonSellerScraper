/**
 * Golden corpus: Parsers against the expected.json written from each page.
 *
 * Checks today's code gets wrong are listed in KNOWN with their finding id
 * and run as test.failing. When a fix lands the check passes, test.failing
 * reports that, and the entry comes out of KNOWN.
 *
 * A test.failing passes on any error, a crash included, so every page also
 * gets plain checks that must hold today: the parsers run without throwing
 * and return the right shape. A broken harness or parser fails those.
 */
const Parsers = require('../../scripts/lib/parsers');
const { corpus, parseDoc } = require('../setup/corpus');

const KNOWN = {
  '2026-09/aod-pinned-only': {
    'seller prices': 'F-30',
    'total offer count': 'F-37',
  },
};

const used = new Set();
function check(id, name, fn) {
  const fid = KNOWN[id] && KNOWN[id][name];
  if (fid) {
    used.add(`${id}|${name}`);
    test.failing(`${name} [known failure ${fid}]`, fn);
  } else {
    test(name, fn);
  }
}

const pageNumber = (href, base) => Number(new URL(href, base).searchParams.get('page'));

for (const page of corpus()) {
  const { id, expected: exp } = page;

  describe(id, () => {
    let doc;
    let parsed;
    beforeAll(() => {
      doc = parseDoc(page.html, exp.url);
      parsed = Parsers.parseSearchPage(doc, exp.url);
    });

    test('parses without throwing', () => {
      expect(() => Parsers.parseSearchPage(doc, exp.url)).not.toThrow();
      expect(Array.isArray(parsed.products)).toBe(true);
      expect(typeof parsed.kind).toBe('string');
    });

    if (exp.type === 'search') {
      check(id, 'page kind', () => {
        expect(parsed.kind).toBe(exp.kind);
      });

      check(id, 'each ASIN once', () => {
        const asins = parsed.products.map((p) => p.asin);
        expect(asins.length).toBe(new Set(asins).size);
      });

      check(id, 'only search-result cards', () => {
        const found = [...new Set(parsed.products.map((p) => p.asin))].sort();
        expect(found).toEqual([...exp.asins].sort());
      });

      check(id, 'placement count', () => {
        expect(parsed.placements).toBe(exp.placements);
      });

      check(id, 'organic ranks run 1..n', () => {
        const ranks = parsed.products.flatMap((p) => p.placements).map((pl) => pl.rank).filter((r) => r !== null);
        expect(ranks.sort((x, y) => x - y)).toEqual(ranks.map((_, i) => i + 1));
        expect(ranks.length).toBe(exp.placements - exp.sponsored);
      });

      check(id, 'sponsored count', () => {
        expect(parsed.products.filter((p) => p.sponsored === true).length).toBe(exp.sponsored);
      });

      check(id, 'no sspa ad links', () => {
        expect(parsed.products.filter((p) => /\/sspa\//.test(p.url || ''))).toEqual([]);
      });

      check(id, 'next page', () => {
        if (exp.next === null) {
          expect(parsed.nextHref).toBeNull();
        } else {
          expect(parsed.nextHref).not.toBeNull();
          expect(pageNumber(parsed.nextHref, exp.url)).toBe(pageNumber(exp.next, exp.url));
        }
      });

      if (exp.nextExact) {
        check(id, 'next href is the page link', () => {
          expect(new URL(parsed.nextHref, exp.url).href).toBe(new URL(exp.next, exp.url).href);
        });
      }

      check(id, 'total results', () => {
        expect(parsed.total).toBe(exp.total);
      });

      if (exp.minFill !== undefined) {
        check(id, 'fill rate', () => {
          expect(parsed.fill.asin).toBeGreaterThanOrEqual(exp.minFill);
          expect(parsed.fill.title).toBeGreaterThanOrEqual(exp.minFill);
          expect(parsed.fill.price).toBeGreaterThanOrEqual(exp.minFill);
        });
      }

      for (const [asin, want] of Object.entries(exp.spot || {})) {
        check(id, `spot ${asin}`, () => {
          const got = parsed.products.find((p) => p.asin === asin);
          expect(got).toBeDefined();
          expect({ name: got.name, priceCents: got.priceCents }).toEqual(want);
        });
      }
    }

    if (exp.offers) {
      test('offer parser runs on an offers page', () => {
        let prices;
        expect(() => { prices = Parsers.extractPricesFromDocument(doc); }).not.toThrow();
        expect(Array.isArray(prices)).toBe(true);
      });

      check(id, 'seller prices', () => {
        expect(Parsers.extractPricesFromDocument(doc)).toEqual(exp.offers.prices);
      });

      if (exp.offers.totalOfferCount !== undefined) {
        check(id, 'total offer count', () => {
          expect(typeof Parsers.totalOfferCount).toBe('function');
          expect(Parsers.totalOfferCount(doc)).toBe(exp.offers.totalOfferCount);
        });
      }
    }
  });
}

test('every known failure names a real check', () => {
  const listed = Object.entries(KNOWN).flatMap(([id, checks]) => Object.keys(checks).map((n) => `${id}|${n}`));
  expect(listed.filter((k) => !used.has(k))).toEqual([]);
});
