// Ad-platform match keys for the server-side conversion (#375, ads/openai-capi.ts): the OpenAI pixel's `__obref` browser
// reference and the storefront's first-party visitor id, sent with POST /v1/shop/checkout, plus the client IP address and
// user agent of that request. Stored as order.metadata.adMatch, never part of the idempotency fingerprint, never used for
// money or access. IP address and user agent are removed once the conversion has been accepted.
import { z } from '@hono/zod-openapi';

// eslint-disable-next-line no-control-regex
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;

export const OrderTrackingIn = z
  .object({
    obref: z.string().max(256).regex(PRINTABLE).optional(),
    visitorId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
  })
  .strict()
  .openapi({ description: "Ad match keys: the OpenAI pixel's __obref cookie value and the storefront's first-party visitor id." });

export type OrderAdMatch = { obref?: string; visitorId?: string; ip?: string; userAgent?: string };

/** The adMatch block to store, or null when nothing usable remains. */
export function adMatchFor(tracking: unknown, ip: string | null | undefined, userAgent: string | null | undefined): OrderAdMatch | null {
  const t = (tracking && typeof tracking === 'object' && !Array.isArray(tracking) ? tracking : {}) as Record<string, unknown>;
  const out: OrderAdMatch = {};
  if (typeof t.obref === 'string' && PRINTABLE.test(t.obref) && t.obref.trim()) out.obref = t.obref.trim().slice(0, 256);
  if (typeof t.visitorId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(t.visitorId)) out.visitorId = t.visitorId;
  // Only a real address (not the 'unknown' placeholder) and a printable agent of bounded size.
  if (ip && /^[0-9a-f:.]+$/i.test(ip)) out.ip = ip;
  const ua = (userAgent ?? '').trim();
  if (ua && PRINTABLE.test(ua)) out.userAgent = ua.slice(0, 512);
  // IP address / user agent alone are not worth keeping: only store them with a key the storefront sent.
  return out.obref || out.visitorId ? out : null;
}
