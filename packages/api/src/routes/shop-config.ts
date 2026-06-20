/**
 * Public storefront runtime config. The storefront can fetch this to learn the
 * active Stripe mode and the matching publishable key for this store.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { resolveStoreFromCtx } from './store-context.js';
import { stripeModeFromConfig, stripePublishableForClient, stripeUsable } from '../payments/stripe.js';

export const shopConfig = new OpenAPIHono();

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
        }) } },
      },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const mode = stripeModeFromConfig(st.config);
    return c.json({
      stripeMode: mode,
      stripePublishableKey: stripePublishableForClient(mode),
      stripeConfigured: stripeUsable(mode),
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
    return c.json({ publishableKey: stripePublishableForClient(mode) }, 200);
  },
);
