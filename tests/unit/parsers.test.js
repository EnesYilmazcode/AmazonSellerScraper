const Parsers = require('../../scripts/lib/parsers');
const Price = require('../../scripts/modules/price');
const { parseDoc } = require('../setup/corpus');

const card = (asin, price) => `
  <div class="s-result-item" data-asin="${asin}">
    <h2><span>Item ${asin}</span></h2>
    ${price ? `<div class="a-price" data-a-size="xl"><span class="a-offscreen">${price}</span></div>` : ''}
    <a class="a-link-normal s-no-outline" href="/dp/${asin}"></a>
  </div>`;
const page = (body) => `<!DOCTYPE html><html><body>${body}</body></html>`;
const URL_P1 = 'https://www.amazon.com/s?k=widget';

describe('Parsers.parseSearchPage', () => {
  test('a page with results and a live Next button', () => {
    const doc = parseDoc(page(card('B0A', '$1.00') + card('B0B', '$2.50') + '<a class="s-pagination-next">Next</a>'), URL_P1);
    const r = Parsers.parseSearchPage(doc, URL_P1);
    expect(r.kind).toBe('results');
    expect(r.products.map((p) => p.asin)).toEqual(['B0A', 'B0B']);
    expect(r.products[1].priceCents).toBe(250);
    expect(r.nextHref).toBe('https://www.amazon.com/s?k=widget&page=2&ref=sr_pg_2');
  });

  test('a disabled Next button makes it the last page', () => {
    const doc = parseDoc(page(card('B0A', '$1.00') + '<span class="s-pagination-next s-pagination-disabled"></span>'), URL_P1);
    const r = Parsers.parseSearchPage(doc, URL_P1);
    expect(r.kind).toBe('last');
    expect(r.nextHref).toBeNull();
  });

  test('no result cards is empty', () => {
    const doc = parseDoc(page('<p>nothing</p>'), URL_P1);
    const r = Parsers.parseSearchPage(doc, URL_P1);
    expect(r).toEqual({ kind: 'empty', products: [], nextHref: null, total: 0, fill: { asin: 0, title: 0, price: 0 } });
  });

  test('the next page is the Next link itself, resolved against the page', () => {
    const next = '<a class="s-pagination-next" href="/s?k=widget&amp;page=2&amp;qid=9&amp;ref=sr_pg_1">Next</a>';
    const r = Parsers.parseSearchPage(parseDoc(page(card('B0A', '$1.00') + next), URL_P1), URL_P1);
    expect(r.kind).toBe('results');
    expect(r.nextHref).toBe('https://www.amazon.com/s?k=widget&page=2&qid=9&ref=sr_pg_1');
  });

  test('no pagination strip at all is the last page', () => {
    const r = Parsers.parseSearchPage(parseDoc(page(card('B0A', '$1.00')), URL_P1), URL_P1);
    expect(r.kind).toBe('last');
    expect(r.nextHref).toBeNull();
  });

  test.each([
    ['a captcha form', '<form action="/errors/validateCaptcha"><input id="captchacharacters"></form>', URL_P1, 'captcha'],
    ['a Robot Check title', '<title>Robot Check</title><p>x</p>', URL_P1, 'captcha'],
    ['a sign-in form', '<form name="signIn"><input id="ap_email"></form>', 'https://www.amazon.com/ap/signin?x=1', 'signin'],
    ['a meta refresh bot check', '<meta http-equiv="refresh" content="5; URL=/s?k=a">', URL_P1, 'interstitial'],
    ['a search page with no cards', '<div class="s-main-slot"></div>', URL_P1, 'empty'],
    ['a product page', '<div id="dp">Echo Dot</div>', 'https://www.amazon.com/dp/B09B8V1LZ3', 'unknown'],
  ])('a page with %s is %s', (_label, body, url, kind) => {
    expect(Parsers.classifyPage(parseDoc(page(body), url), url)).toBe(kind);
    expect(Parsers.parseSearchPage(parseDoc(page(body), url), url).kind).toBe(kind);
  });

  test('fill counts products with a price', () => {
    const doc = parseDoc(page(card('B0A', '$1.00') + card('B0B', null)), URL_P1);
    expect(Parsers.parseSearchPage(doc, URL_P1).fill).toEqual({ asin: 1, title: 1, price: 0.5 });
  });
});

describe('Parsers helpers', () => {
  test('getNextPageUrl increments the page', () => {
    expect(Parsers.getNextPageUrl('https://www.amazon.com/s?k=a&page=3')).toBe('https://www.amazon.com/s?k=a&page=4&ref=sr_pg_4');
  });

  test('priceToCents is the one from Price', () => {
    for (const s of ['$1,299.99', 'N/A', '$0.35', null]) {
      expect(Parsers.priceToCents(s)).toBe(Price.priceToCents(s));
    }
  });

  test('analyzer coercions keep their old results', () => {
    expect(Parsers.toDollars('$1,299.99')).toBe(1299.99);
    expect(Parsers.toDollars('N/A')).toBe(0);
    expect(Parsers.toRating('4.5')).toBe(4.5);
    expect(Parsers.toReviewCount('12,847')).toBe(12847);
  });

  test('offer prices come from the first selector that has any', () => {
    const doc = parseDoc(page('<div id="olpOfferList"><div class="a-price"><span class="a-offscreen">$5.00</span></div></div><span class="olpOfferPrice">$9.00</span>'), URL_P1);
    expect(Parsers.extractPricesFromDocument(doc)).toEqual([5]);
  });
});
