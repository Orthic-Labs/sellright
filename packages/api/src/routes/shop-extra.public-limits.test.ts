import { describe, expect, it } from 'vitest';
import {
  CATALOG_SEARCH_PER_MIN, LEGACY_NEWSLETTER_LINK_PER_MIN, SHIPPING_QUOTE_PER_MIN,
  consumeCatalogSearch, consumeLegacyNewsletterLink, consumeShippingQuote,
} from './shop-extra.public-limits.js';

let n = 0;
const ip = () => `198.51.100.${++n % 250}`;

describe.each([
  ['shipping quote', consumeShippingQuote, SHIPPING_QUOTE_PER_MIN],
  ['catalog search', consumeCatalogSearch, CATALOG_SEARCH_PER_MIN],
  ['legacy newsletter link', consumeLegacyNewsletterLink, LEGACY_NEWSLETTER_LINK_PER_MIN],
] as const)('%s budget', (_name, consume, max) => {
  it('allows the budget then blocks with a positive retryAfter', async () => {
    const addr = ip();
    for (let i = 0; i < max; i++) expect(await consume('store-a', addr)).toBe(0);
    expect(await consume('store-a', addr)).toBeGreaterThan(0);
  });

  it('is keyed per store and per ip', async () => {
    const addr = ip();
    for (let i = 0; i < max; i++) await consume('store-a', addr);
    expect(await consume('store-b', addr)).toBe(0);
    expect(await consume('store-a', ip())).toBe(0);
  });
});
