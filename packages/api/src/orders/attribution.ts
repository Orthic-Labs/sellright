// Marketing attribution captured by the storefront from the shopper's landing URL (UTM parameters and the ad platforms'
// `oppref` click reference) and sent with POST /v1/shop/checkout. Stored on the order as `metadata.attribution`, so no
// schema change: the order row (FORCE RLS, per store) already carries a jsonb metadata column written in the same
// store-scoped transaction as the order. Validation is strict: only the allowlisted keys, each a printable string of at
// most ATTRIBUTION_MAX_CHARS. The value is a claim from the browser, never trusted for money, access or reporting
// exclusions; it is excluded from the checkout idempotency fingerprint, so a retry carrying a different landing claim
// still replays the original order.
import { z } from '@hono/zod-openapi';

export const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'oppref'] as const;
export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];
export type OrderAttribution = Partial<Record<AttributionKey, string>>;

export const ATTRIBUTION_MAX_CHARS = 256;

// eslint-disable-next-line no-control-regex
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;
const value = z.string().max(ATTRIBUTION_MAX_CHARS).regex(PRINTABLE).optional();

export const OrderAttributionIn = z
  .object(Object.fromEntries(ATTRIBUTION_KEYS.map((k) => [k, value])) as Record<AttributionKey, typeof value>)
  .strict()
  .openapi({ description: 'Landing-URL attribution (UTM parameters and oppref) to store on the order. Allowlisted keys only; each value at most 256 printable characters.' });

/** Trimmed, non-empty allowlisted values only; null when nothing remains. Used on write and on every read-back. */
export function normalizeAttribution(raw: unknown): OrderAttribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: OrderAttribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== 'string' || !PRINTABLE.test(v)) continue;
    const trimmed = v.trim().slice(0, ATTRIBUTION_MAX_CHARS);
    if (trimmed) out[key] = trimmed;
  }
  return Object.keys(out).length ? out : null;
}

/** The stored attribution of an order, read back from its metadata (null when none). */
export function orderAttribution(metadata: unknown): OrderAttribution | null {
  return normalizeAttribution((metadata as { attribution?: unknown } | null)?.attribution);
}
