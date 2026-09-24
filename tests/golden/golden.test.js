/**
 * Golden corpus: Parsers against the expected.json written from each page.
 *
 * Checks today's code gets wrong are listed in KNOWN with their finding id
 * and run as test.failing. When a fix lands the check passes, test.failing
 * reports that, and the entry comes out of KNOWN.
 */
const Parsers = require('../../scripts/lib/parsers');
const { corpus, parseDoc } = require('../setup/corpus');

const KNOWN = {
  '2026-09/search-yoga-mat': {
    'each ASIN once': 'F-27',
    'only search-result cards': 'F-27',
    'sponsored count': 'F-16',
    'no sspa ad links': 'F-16',
    'next href is the page link': 'F-15',
    'total results': 'F-25',
  },
  '2026-09/search-title-recipe-synthetic': {
    'each ASIN once': 'F-27',
    'sponsored count': 'F-16',
    'no sspa ad links': 'F-16',
    'next href is the page link': 'F-15',
    'spot B0SPONS001': 'F-17',
    'spot B0UNITONLY': 'F-17',
  },
  '2026-09/search-no-pagination-synthetic': {
    'page kind': 'F-15',
    'next page': 'F-15',
  },
  '2026-09/interstitial-akamai': { 'page kind': 'F-12' },
  '2026-09/captcha-synthetic': { 'page kind': 'F-12' },
  '2026-09/product-dp': { 'page kind': 'F-11' },
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
