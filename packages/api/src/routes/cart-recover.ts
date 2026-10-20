/** GET /v1/shop/cart/recover/{cartId}?exp&sig — the link in the abandoned-cart
 *  reminder email. Validates the HMAC + expiry, then redirects to the storefront
 *  recovery page with the cart token in the URL FRAGMENT (never sent to servers,
 *  logs or Referer); the page installs the `sr_cart` cookie and continues to
 *  checkout. The API never sets that cookie itself — the storefront owns it. */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveStoreFromCtx } from './store-context.js';
import { verifyRecovery } from '../cart/recovery-link.js';
import { resolveStorefrontUrl } from '../email/dispatch.js';

export const cartRecover = new OpenAPIHono();

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:48px auto;padding:0 24px;color:#222"><h2>${title}</h2><p>${body}</p></body></html>`;

cartRecover.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/cart/recover/{cartId}',
    summary: 'Resume an abandoned cart from a signed email link',
    request: { params: z.object({ cartId: z.string().uuid() }), query: z.object({ exp: z.string().max(20), sig: z.string().max(128) }) },
    responses: {
      302: { description: 'Redirect to the storefront recovery page' },
      403: { description: 'Bad signature', content: { 'text/html': { schema: z.string() } } },
      410: { description: 'Expired link', content: { 'text/html': { schema: z.string() } } },
    },
  }),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const st = await resolveStoreFromCtx(c).catch(() => null);
    if (!st) return c.html(page('Invalid link', 'This link is invalid.'), 403);
    const { cartId } = c.req.valid('param');
    const { exp, sig } = c.req.valid('query');
    const verdict = verifyRecovery(st.id, cartId, exp, sig);
    if (verdict === 'invalid') return c.html(page('Invalid link', 'This link is invalid or has been altered.'), 403);
    if (verdict === 'expired') return c.html(page('Link expired', 'This link has expired. Your items may still be in your cart on the store.'), 410);
    const base = resolveStorefrontUrl({ name: st.name, currency: st.currency, config: st.config, storeId: st.id });
    const row = await withStore(st.id, async (tx) => (await tx.select({ token: s.cart.token }).from(s.cart).where(and(
      eq(s.cart.storeId, st.id), eq(s.cart.id, cartId), inArray(s.cart.status, ['active', 'abandoned']), isNull(s.cart.convertedOrderId),
    )))[0]);
    // Converted / merged / purged cart: nothing to resume — land on the store, reveal nothing.
    if (!row) return c.redirect(`${base}/`, 302);
    return c.redirect(`${base}/cart/recover/#t=${encodeURIComponent(row.token)}`, 302);
  },
);
