/**
 * Reusable product test data mimicking scraper output.
 * Covers normal products and edge cases (N/A price, no rating, zero reviews).
 */

const sampleProducts = [
  {
    name: 'Widget Pro',
    asin: 'B001',
    price: '$29.99',
    rating: 4.5,
    reviewCount: 1200,
    isPrime: true,
    url: 'https://www.amazon.com/dp/B001',
    scrapedAt: '2026-04-12T10:00:00.000Z'
  },
  {
    name: 'Widget Basic',
    asin: 'B002',
    price: '$12.99',
    rating: 4.2,
    reviewCount: 350,
    isPrime: false,
    url: 'https://www.amazon.com/dp/B002',
    scrapedAt: '2026-04-12T10:00:00.000Z'
  },
  {
    name: 'Widget Ultra',
    asin: 'B003',
    price: '$89.99',
    rating: 4.8,
    reviewCount: 5600,
    isPrime: true,
    url: 'https://www.amazon.com/dp/B003',
    scrapedAt: '2026-04-12T10:00:00.000Z'
  },
  {
    name: 'Widget Mini',
    asin: 'B004',
    price: '$5.99',
    rating: 3.2,
    reviewCount: 20,
    isPrime: false,
    url: 'https://www.amazon.com/dp/B004',
    scrapedAt: '2026-04-12T10:00:00.000Z'
  },
  {
    name: 'Widget Gold',
    asin: 'B005',
    price: '$149.99',
    rating: 4.9,
    reviewCount: 8900,
    isPrime: true,
    url: 'https://www.amazon.com/dp/B005',
    scrapedAt: '2026-04-12T10:00:00.000Z'
  },
  {
    name: 'No Price Item',
    asin: 'B006',
    price: 'N/A',
    rating: 4.0,
    reviewCount: 100,
    isPrime: false,
    url: 'https://www.amazon.com/dp/B006',
    scrapedAt: '2026-04-12T10:00:00.000Z'
  },
  {
    name: 'No Rating Item',
    asin: 'B007',
    price: '$19.99',
    rating: 0,
    reviewCount: 0,
    isPrime: false,
    url: 'https://www.amazon.com/dp/B007',
    scrapedAt: '2026-04-12T10:00:00.000Z'
  }
];

const sampleSpreadResults = {
  'B001': {
    asin: 'B001',
    productName: 'Widget Pro',
    listPrice: '$29.99',
    sellerPrices: [24.99, 29.99, 31.50, 27.00, 35.00],
    fetchedAt: '2026-04-12T11:00:00.000Z'
  },
  'B002': {
    asin: 'B002',
    productName: 'Widget Basic',
    listPrice: '$12.99',
    sellerPrices: [12.50, 13.00, 12.99],
    fetchedAt: '2026-04-12T11:00:00.000Z'
  },
  'B003': {
    asin: 'B003',
    productName: 'Widget Ultra',
    listPrice: '$89.99',
    sellerPrices: [60.00, 89.99, 95.00, 120.00, 75.00],
    fetchedAt: '2026-04-12T11:00:00.000Z'
  },
  'B004': null,
  'B005': {
    asin: 'B005',
    productName: 'Widget Gold',
    listPrice: '$149.99',
    sellerPrices: [149.99],
    fetchedAt: '2026-04-12T11:00:00.000Z'
  }
};

module.exports = { sampleProducts, sampleSpreadResults };
