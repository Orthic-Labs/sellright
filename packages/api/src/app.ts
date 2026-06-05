import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { catalog } from './routes/catalog.js';
import { cart } from './routes/cart.js';

/**
 * The API is typed REST: every route declares a zod schema, which generates
 * both the OpenAPI contract (/v1/openapi.json) and the typed `hc` client the
 * Qwik storefront + admin consume. No GraphQL. See docs/BUILD-PLAN-RH-v1.md §4.
 */
export function createApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  const healthRoute = createRoute({
    method: 'get',
    path: '/v1/health',
    summary: 'Liveness probe',
    responses: {
      200: {
        description: 'Service is up',
        content: {
          'application/json': {
            schema: z.object({
              status: z.literal('ok'),
              version: z.string(),
            }),
          },
        },
      },
    },
  });

  app.openapi(healthRoute, (c) => c.json({ status: 'ok' as const, version: '0.0.0' }));

  app.onError((err, c) => {
    // eslint-disable-next-line no-console
    console.error('[api error]', err);
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
  });

  // Shop catalog read API (store resolved per-request, RLS-scoped).
  app.route('/', catalog);
  app.route('/', cart);

  // Published API contract — the product surface (versioned under /v1).
  app.doc('/v1/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Commerce Platform API', version: '0.0.0' },
  });

  return app;
}
