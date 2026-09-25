const PageKind = require('../../scripts/lib/page-kind');

const A = 'https://www.amazon.com';

describe('pages that get the Scrape suggestion', () => {
  test.each([
    [`${A}/s?k=yoga+mat`, 'search', { keyword: 'yoga mat' }],
    [`${A}/s?k=usb+c&page=3&ref=sr_pg_3`, 'search', { keyword: 'usb c' }],
    [`${A}/s?rh=n%3A3407731&fs=true`, 'search', { keyword: null }],
    [`${A}/s?me=A1B2C3D4E5F6G7&marketplaceID=ATVPDKIKX0DER`, 'storefront', { sellerId: 'A1B2C3D4E5F6G7' }],
    [`${A}/s?me=a1b2c3d4e5f6g7&k=lamp`, 'storefront', { sellerId: 'A1B2C3D4E5F6G7' }],
    [`https://smile.amazon.com/s?k=desk`, 'search', {}],
  ])('%s is %s', (url, kind, extra) => {
    const got = PageKind.classify(url);
    expect(got).toMatchObject({ kind, ...extra });
    expect(PageKind.scrapable(url)).toBe(true);
    expect(PageKind.suggests(url)).toBe(true);
  });

  test('a seller profile points at its storefront but cannot start a run itself', () => {
    const url = `${A}/sp?ie=UTF8&seller=A1B2C3D4E5F6G7&isAmazonFulfilled=1`;
    expect(PageKind.classify(url)).toMatchObject({ kind: 'seller', sellerId: 'A1B2C3D4E5F6G7' });
    expect(PageKind.suggests(url)).toBe(true);
    expect(PageKind.scrapable(url)).toBe(false);
    expect(PageKind.storefrontUrl('A1B2C3D4E5F6G7')).toBe(`${A}/s?me=A1B2C3D4E5F6G7&marketplaceID=ATVPDKIKX0DER`);
  });

  test('a brand store is a store page, not a scrapable one', () => {
    const url = `${A}/stores/Gaiam/page/4F1C1B7A-6C0B-4D0B-9E1F-3B7B2C8D9E10`;
    expect(PageKind.classify(url)).toMatchObject({ kind: 'store', sellerId: null });
    expect(PageKind.scrapable(url)).toBe(false);
  });
});

describe('pages that never get it', () => {
  test.each([
    `${A}/dp/B09B8V1LZ3`,
    `${A}/Gaiam-Thick-Yoga-Mat/dp/B09B8V1LZ3/ref=sr_1_1?k=yoga+mat`,
    `${A}/gp/product/B09B8V1LZ3`,
    `${A}/gp/aw/d/B09B8V1LZ3`,
    `${A}/gp/offer-listing/B09B8V1LZ3`,
    `${A}/gp/aod/ajax?asin=B09B8V1LZ3`,
    `${A}/gp/cart/view.html?ref_=nav_cart`,
    `${A}/cart`,
    `${A}/cart/smart-wagon?newItems=1`,
    `${A}/gp/buy/spc/handlers/display.html`,
    `${A}/checkout/p/p-123/spc`,
    `${A}/ap/signin?openid.return_to=%2Fs%3Fk%3Dmat`,
    `${A}/gp/css/homepage.html`,
    `${A}/gp/your-account/order-history`,
    `${A}/your-orders/orders`,
    `${A}/hz/wishlist/ls`,
    `${A}/a/addresses`,
    `${A}/cpe/yourpayments/wallet`,
    'https://example.com/s?k=yoga+mat',
    'not a url',
  ])('%s', (url) => {
    expect(PageKind.classify(url).kind).toBe('never');
    expect(PageKind.suggests(url)).toBe(false);
    expect(PageKind.scrapable(url)).toBe(false);
  });

  test('the home page and a bare /s are quiet', () => {
    for (const url of [`${A}/`, `${A}/s`, `${A}/gp/bestsellers`, `${A}/sp?seller=`]) {
      expect(PageKind.suggests(url)).toBe(false);
    }
  });

  test('a me= value that is not a seller id is not a storefront', () => {
    expect(PageKind.classify(`${A}/s?me=<script>&k=mat`)).toMatchObject({ kind: 'search', sellerId: null });
  });
});

describe('where the dock stays off the page', () => {
  test.each([
    `${A}/gp/cart/view.html`, `${A}/cart`, `${A}/gp/buy/spc/handlers/display.html`, `${A}/checkout/p/p-1/spc`,
    `${A}/ap/signin`, `${A}/gp/css/homepage.html`, `${A}/gp/your-account/order-history`, `${A}/your-orders/orders`,
    `${A}/a/addresses`, `${A}/cpe/yourpayments/wallet`, 'https://example.com/',
  ])('%s', (url) => expect(PageKind.hidden(url)).toBe(true));

  test('product, search and other pages keep the launcher', () => {
    for (const url of [`${A}/dp/B09B8V1LZ3`, `${A}/s?k=mat`, `${A}/`, `${A}/sp?seller=A1B2C3D4E5F6G7`]) {
      expect(PageKind.hidden(url)).toBe(false);
    }
  });
});
