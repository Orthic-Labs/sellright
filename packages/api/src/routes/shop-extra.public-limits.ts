/**
 * Per-(store, IP) sliding-window budgets for public shop endpoints that were previously unthrottled. Atomic
 * (rateLimitBackend().consume), so concurrent requests cannot all pass. Each returns retryAfter seconds (0 = allowed).
 * Budgets are set well above real shopper use; they stop scripted floods only.
 */
import { rateLimitBackend } from '../auth/rate-limit-backend.js';

const MIN = 60 * 1000;

export const SHIPPING_QUOTE_PER_MIN = 60;
export const CATALOG_SEARCH_PER_MIN = 60;
export const LEGACY_NEWSLETTER_LINK_PER_MIN = 20;

const consume = (bucket: string, max: number) => (storeId: string, ip: string): Promise<number> =>
  rateLimitBackend().consume(bucket, JSON.stringify([storeId, ip]), MIN, max);

export const consumeShippingQuote = consume('shop-shipping-quote', SHIPPING_QUOTE_PER_MIN);
export const consumeCatalogSearch = consume('shop-catalog-search', CATALOG_SEARCH_PER_MIN);
export const consumeLegacyNewsletterLink = consume('listmonk-legacy-link', LEGACY_NEWSLETTER_LINK_PER_MIN);
