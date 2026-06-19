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
