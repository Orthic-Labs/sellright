import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { catalog } from './routes/catalog.js';
import { cart } from './routes/cart.js';
import { checkout } from './routes/checkout.js';
import { pay } from './routes/pay.js';
import { auth } from './routes/auth.js';
import { account } from './routes/account.js';
import { orders } from './routes/orders.js';
import { admin } from './routes/admin.js';
import { adminDashboard } from './routes/admin-dashboard.js';
import { adminCatalog } from './routes/admin-catalog.js';
import { adminProducts } from './routes/admin-products.js';
import { adminOrders } from './routes/admin-orders.js';
import { adminOrderOps } from './routes/admin-order-ops.js';
import { adminMarketing } from './routes/admin-marketing.js';
import { adminSettings } from './routes/admin-settings.js';
import { adminSettingsAdvanced } from './routes/admin-settings-advanced.js';
import { adminReports } from './routes/admin-reports.js';
import { adminAffiliate } from './routes/admin-affiliate.js';
import { adminContent } from './routes/admin-content.js';
import { adminAssets } from './routes/admin-assets.js';
import { shopExtra } from './routes/shop-extra.js';
import { shopConfig } from './routes/shop-config.js';
import { customerTokens } from './routes/customer-tokens.js';
import { paymentWebhooks } from './routes/payment-webhooks.js';
import { subscriptions } from './routes/subscriptions.js';
import { apps } from './routes/apps.js';
import { csrfValid, customerCsrfValid, getCustomerSessionToken } from './auth/cookies.js';

/**
 * The API is typed REST: every route declares a zod schema, which generates
 * both the OpenAPI contract (/v1/openapi.json) and typed clients for consumers.
 * No GraphQL. See docs/ARCHITECTURE.md.
 */
export function createApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  // CSRF guard for cookie-based admin mutations (bearer/API clients are exempt;
  // login/logout don't yet have a session). Double-submit token (x-csrf-token
  // must match the sr_csrf cookie). Registered before routes.
  app.use('/v1/admin/*', async (c, next) => {
    const m = c.req.method;
    if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
      const p = c.req.path;
      const exempt = p === '/v1/admin/login' || p === '/v1/admin/logout';
      if (!exempt && !csrfValid(c)) return c.json({ error: 'CSRF token missing or invalid' }, 403);
    }
    await next();
  });

  // Shop-surface CSRF guard (WP1.1). Mirrors the admin block: cookie-session
  // requests must double-submit the customer CSRF token. Bearer/API clients are
  // exempt; guest checkouts (no session) pass through; login/register exempt.
  app.use('/v1/shop/*', async (c, next) => {
    const m = c.req.method;
    if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
      const p = c.req.path;
      const exempt =
        p === '/v1/shop/auth/login' ||
        p === '/v1/shop/auth/register' ||
        p === '/v1/shop/auth/google' ||
        // Pre-session token endpoints (WP2d) — no customer cookie exists yet.
        p === '/v1/shop/auth/forgot-password' ||
        p === '/v1/shop/auth/reset-password' ||
        p === '/v1/shop/auth/verify-email';
      if (!exempt && getCustomerSessionToken(c) && !customerCsrfValid(c)) {
        return c.json({ error: 'CSRF token missing or invalid' }, 403);
      }
    }
    await next();
  });

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
    const expose = process.env.NODE_ENV !== 'production';
    return c.json({ error: expose && err instanceof Error ? err.message : 'internal error' }, 500);
  });

  // Shop catalog read API (store resolved per-request, RLS-scoped).
  app.route('/', catalog);
  app.route('/', cart);
  app.route('/', checkout);
  app.route('/', pay);
  app.route('/', auth);
  app.route('/', shopConfig);
  app.route('/', customerTokens);
  app.route('/', account);
  app.route('/', orders);
  app.route('/', paymentWebhooks); // WP3: inbound Stripe webhooks (signature-auth, no CSRF/cookie)
  app.route('/', apps); // software licenses, app update manifests, admin app releases
  app.route('/', subscriptions); // recurring billing: shop subscribe/portal + admin list

  // Admin API — operator surface (auth, dashboard, orders, products, customers).
  app.route('/', admin);
  app.route('/', adminDashboard); // store dashboard KPIs
  app.route('/', adminProducts); // product list/detail/edit + variant pricing/stock
  app.route('/', adminCatalog); // catalog mgmt: product/variant create+delete, collections, inventory
  app.route('/', adminOrders); // orders++: refunds, draft orders, abandoned carts
  app.route('/', adminOrderOps); // draft orders, tracking import, export, bulk order operations
  app.route('/', adminMarketing); // promotions manager + Listmonk integration
  app.route('/', adminSettings); // store/tax, payments, shipping, staff/roles, notifications
  app.route('/', adminSettingsAdvanced); // webhooks, staff, currency rates
  app.route('/', adminReports); // customers write, reports, search, activity
  app.route('/', adminAffiliate); // affiliate program + public self-serve dashboard
  app.route('/', adminContent); // blog CMS admin
  app.route('/', adminAssets); // WP8: asset upload + management
  app.route('/', shopExtra); // shop: guest tracking, public blog, shipping eligibility, newsletter

  // Published API contract — the product surface (versioned under /v1).
  app.doc('/v1/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Commerce Platform API', version: '0.0.0' },
  });

  return app;
}
