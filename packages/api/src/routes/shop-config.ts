/**
 * Public storefront runtime config. The storefront can fetch this to learn the
 * active Stripe mode and the matching publishable key for this store.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { resolveStoreFromCtx } from './store-context.js';
import { resolveConfiguredGatewayAccount, nmiEnvironment } from '../payments/gateway-account.js';
import { isPaymentMethodEnabled } from '../payments/provider.js';
import { stripeModeFromConfig, resolveStripePublishableForClient, resolveStripeUsable } from '../payments/stripe.js';
import { loyaltySettingsFromConfig } from '../money/loyalty.js';
import { PublicLoyaltySettings } from './loyalty.js';
import { canViewStorefront, isStorePublished, StoreNotPublishedError } from '../store-publish.js';
import { storeIdentityFromConfig, StoreIdentitySchema } from './store-identity.js';

export const shopConfig = new OpenAPIHono();

/** WS-C: the preview token may arrive as a header (linked-to preview, set by
 *  the storefront from a `?preview_token=` query param on first load) or as a
 *  query param directly (bookmarkable preview links). Either is accepted. */
function previewTokenFromCtx(c: { req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined } }): string | undefined {
  return c.req.header('x-preview-token') || c.req.query('preview_token') || undefined;
}

shopConfig.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/config',
    summary: 'Public storefront runtime config (active Stripe mode + publishable key)',
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.object({
          stripeMode: z.enum(['test', 'live']),
          stripePublishableKey: z.string().nullable(),
          stripeConfigured: z.boolean(),
          gateways: z.object({ nmi: z.object({ tokenizationKey: z.string(), mode: z.enum(['test','live']), environment: z.enum(['sandbox', 'production']) }).nullable(), sezzle: z.boolean() }),
          // Points program terms (null while the program is off) — lets the
          // storefront show points-to-earn and the redeem control.
          loyalty: PublicLoyaltySettings.nullable(),
        }) } },
      },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const mode = stripeModeFromConfig(st.config);
    let nmi: { tokenizationKey: string; mode: 'test'|'live'; environment: 'sandbox'|'production' } | null = null;
    let sezzle = false;
    try { if (isPaymentMethodEnabled(st.config, 'nmi')) {
      const account = await resolveConfiguredGatewayAccount(st.id, 'nmi', st.config);
      if (account.tokenizationKey) nmi = { tokenizationKey: account.tokenizationKey, mode: account.mode, environment: nmiEnvironment(account) };
    } } catch { /* An unavailable account is not advertised to shoppers. */ }
    try { if (isPaymentMethodEnabled(st.config, 'sezzle')) { await resolveConfiguredGatewayAccount(st.id, 'sezzle', st.config); sezzle = true; } } catch { /* fail closed */ }
    const loyalty = loyaltySettingsFromConfig(st.config);
    return c.json({
      gateways: { nmi, sezzle },
      loyalty: loyalty.enabled ? loyalty : null,
      stripeMode: mode,
      stripePublishableKey: await resolveStripePublishableForClient(st.id, mode),
      stripeConfigured: isPaymentMethodEnabled(st.config, 'stripe') && (await resolveStripeUsable(st.id, mode)),
    }, 200);
  },
);

// GET /v1/shop/stripe-key — the mode-appropriate publishable key alone (the
// checkout Stripe.js loader). The publishable key is public-by-design; it is
// served from a normal API response (never a CDN-cached edge). client_secret is
// NOT here — that is per-PI and only returned by the order-scoped /payment-intent.
shopConfig.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/stripe-key',
    summary: 'Stripe publishable key for the active mode',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ publishableKey: z.string().nullable() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const mode = stripeModeFromConfig(st.config);
    return c.json({ publishableKey: await resolveStripePublishableForClient(st.id, mode) }, 200);
  },
);

// GET /v1/shop/identity — public brand identity/theme/contact/social/SEO
// origin for the resolved store (WS-C). Gated on publish state: an
// unpublished store 404s here (StoreNotPublishedError) unless the caller
// presents a valid preview token, so an unpublished storefront reveals
// nothing — not even its name — to an outside observer (plan §1.5).
shopConfig.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/identity',
    summary: 'Public store identity/theme/contact/social/SEO config for the resolved host',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: StoreIdentitySchema } } },
      404: { description: 'Store not found or not published' },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const token = previewTokenFromCtx(c);
    if (!canViewStorefront(st.config, token)) throw new StoreNotPublishedError();
    return c.json(storeIdentityFromConfig(st, isStorePublished(st.config)), 200);
  },
);
