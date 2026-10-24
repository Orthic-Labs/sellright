import { ImportedFinancialReconciliationError } from './orders/imported-financial-reconciliation.js';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';
import { catalog } from './routes/catalog.js';
import { cart } from './routes/cart.js';
import { checkout } from './routes/checkout.js';
import { pay } from './routes/pay.js';
import { gatewayPayments } from './routes/gateway-payments.js';
import { adminGatewayPayments } from './routes/admin-gateway-payments.js';
import { auth } from './routes/auth.js';
import { account } from './routes/account.js';
import { accountReturns } from './routes/account-returns.js';
import { loyalty } from './routes/loyalty.js';
import { orders } from './routes/orders.js';
import { admin } from './routes/admin.js';
import { setup } from './routes/setup.js';
import { adminSystem } from './routes/admin-system.js';
import { adminSystemInfo } from './routes/admin-system-info.js';
import { adminDashboard } from './routes/admin-dashboard.js';
import { adminCatalog } from './routes/admin-catalog.js';
import { adminProducts } from './routes/admin-products.js';
import { adminOrders } from './routes/admin-orders.js';
import { adminOrderEdit } from './routes/admin-order-edit.js';
import { adminOrderOps } from './routes/admin-order-ops.js';
import { adminMarketing } from './routes/admin-marketing.js';
import { adminSettings } from './routes/admin-settings.js';
import { adminSecurity } from './routes/admin-security.js';
import { adminPasskeys } from './routes/admin-passkeys.js';
import { shopPasskeys } from './routes/shop-passkeys.js';
import { adminLoyalty } from './routes/admin-loyalty.js';
import { reviews } from './routes/reviews.js';
import { adminReviews } from './routes/admin-reviews.js';
import { adminPaymentSettings } from './routes/admin-payment-settings.js';
import { adminEmailSettings } from './routes/admin-email-settings.js';
import { adminSettingsAdvanced } from './routes/admin-settings-advanced.js';
import { adminReports } from './routes/admin-reports.js';
import { adminAffiliate } from './routes/admin-affiliate.js';
import { adminContent } from './routes/admin-content.js';
import { adminAssets, assetUploadAdmission } from './routes/admin-assets.js';
import { adminPush } from './routes/admin-push.js';
import { adminLicenses } from './routes/admin-licenses.js';
import { adminAgents } from './routes/admin-agents.js';
import { createAdminAgentGuard } from './routes/admin-agent-guard.js';
import { buildAgentRouteContext, type AgentRouteContext } from './auth/agent-policy.js';
import { shopExtra } from './routes/shop-extra.js';
import { subscriberRoutes } from './routes/shop-extra.subscriber.js';
import { feeds } from './routes/feeds.js';
import { sheeridRoutes } from './routes/sheerid.js';
import { disputeRoutes } from './routes/disputes.js';
import { shopConfig } from './routes/shop-config.js';
import { seo } from './routes/seo.js';
import { cacheVersion } from './routes/cache-version.js';
import { adminCache } from './routes/admin-cache.js';
import { adminSeo } from './routes/admin-seo.js';
import { adminWaitlist } from './routes/admin-waitlist.js';
import { customerTokens } from './routes/customer-tokens.js';
import { paymentWebhooks } from './routes/payment-webhooks.js';
import { storeKitWebhooks } from './routes/storekit-webhooks.js';
import { subscriptions } from './routes/subscriptions.js';
import { apps } from './routes/apps.js';
import { wellKnown } from './routes/well-known.js';
import { HttpError } from './routes/admin-helpers.js';
import { apiErrorCodeSchema, errorEnvelope, errJson } from './lib/api-error.js';
import { csrfValid, customerCsrfValid, getCustomerSessionToken, cookie, SESSION_COOKIE } from './auth/cookies.js';
import { bearer } from './auth/session.js';
import { resolveAdmin } from './auth/admin-session.js';
import { isAgentToken, resolveAgentByToken } from './auth/admin-api-token.js';
import { CACHE_ADMIN_TOKEN_HEADER } from './routes/admin-cache.js';
import { ASSET_UPLOAD_LIMIT_BYTES } from './routes/admin-assets.js';
import { env } from './env.js';
import { isAllowedAdminCorsOrigin, isAllowedCorsOrigin } from './cors-origins.js';
import { bodyLimit } from 'hono/body-limit';
import { isPoolTimeout, locksPool, poolGauges } from './db/client.js';
import { isMaintenanceOn, maintenanceInfo } from './maintenance.js';
import { requestIdMiddleware, accessLogMiddleware } from './lib/request-id.js';
import { CACHEABLE_EXCEPTIONS, cachePolicy, listRegisteredCacheableExceptions, validateCacheableExceptions, type CacheableException } from './cache-policy.js';
import { err as logErr } from './lib/logger.js';
import { listApiPlugins } from './plugins.js';
import { installDefaultStoreKitPolicy } from './licensing/storekit/default-policy.js';
import { installDefaultPaymentPolicy } from './payments/policy/default-policy.js';
import { SELLRIGHT_VERSION } from './version.js';
import type { EngineContext, EnginePlugin } from './sdk/types.js';
import { createReleaseRegistrationRoutes } from './releases/release-registration.js';
import { assertHostRouteUnshadowed, hostRouteEntryCount, assertNoReleaseRegistrationConflicts, type PolicyOwner } from './releases/registration-policy.js';
import { preRoutePolicy } from './pre-route-policy.js';
import { normalizeExactRouteCorsResponse, resolveExactRouteCorsPolicies } from './exact-route-cors-policy.js';
import { matchesNumericRouteBodyLimit, numericRouteBodyLimit, resolveNumericRouteBodyLimits } from './numeric-route-body-limit.js';

export { SELLRIGHT_VERSION };

/** P2: in production the published contract (admin routes included) is served only to an authenticated admin
 *  (session cookie, bearer session or agent token). Development/test keep it public for client generation. */
export function openapiAdminOnly(isProduction: () => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (!isProduction()) return next();
    const token = bearer(c.req.header('authorization')) ?? cookie(c, SESSION_COOKIE);
    const admin = token ? (isAgentToken(token) ? await resolveAgentByToken(token) : await resolveAdmin(token)) : null;
    if (!admin) return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    await next();
  };
}

export interface HttpAppOptions {
  /** SDK plugins (sdk/create-app.ts). Requires `ctx`. */
  plugins?: readonly EnginePlugin[];
  ctx?: EngineContext;
  /** Admission gate (shutdown step 1): while it returns false every request is answered 503. */
  admit?: () => boolean;
}

/** The one readiness query in flight in this process (#360 N6); probes that arrive meanwhile share it. */
let inflightReadiness: Promise<{ rowCount: number | null }> | undefined;
function readinessProbe(): Promise<{ rowCount: number | null }> {
  inflightReadiness ??= locksPool.query('SELECT 1').finally(() => { inflightReadiness = undefined; });
  return inflightReadiness;
}

/**
 * The API is typed REST: every route declares a zod schema, which generates
 * both the OpenAPI contract (/v1/openapi.json) and typed clients for consumers.
 * No GraphQL. See docs/ARCHITECTURE.md.
 *
 * This builds the Hono app only (no env parse, no pool, no server). The SDK's
 * `createApp` (sdk/create-app.ts) is the entry that owns the runtime lifecycle;
 * it calls this with its plugins. Calling it directly (tests) keeps the legacy
 * behaviour: plugins registered through plugins.ts `registerApiPlugin` are mounted.
 */
export function buildHttpApp(options: HttpAppOptions = {}): OpenAPIHono {
  const app = new OpenAPIHono();
  const sdkPlugins = options.plugins ?? [];
  if (sdkPlugins.length > 0 && !options.ctx) throw new Error('buildHttpApp: plugins require an engine context');
  const corsPolicies = resolveExactRouteCorsPolicies(sdkPlugins);
  const streamBodyLimits = resolveNumericRouteBodyLimits(sdkPlugins).map((policy) => ({ policy, middleware: numericRouteBodyLimit(policy) }));
  const admit = options.admit;

  // Cache policy FIRST so it wraps every response (shutdown 503s, CORS preflights, route output, onError envelopes,
  // 404s): `private, no-store` unless the path is on cache-policy.ts's explicit exception list.
  // SDK plugins' `cacheableExceptions` are validated here (deny list, source/reason, duplicates across the static list,
  // legacy registrations and other plugins) and scoped to THIS app instance.
  const sdkCacheable: CacheableException[] = [];
  for (const plugin of sdkPlugins) {
    if (!plugin.cacheableExceptions?.length) continue;
    sdkCacheable.push(...validateCacheableExceptions(plugin.cacheableExceptions, [...CACHEABLE_EXCEPTIONS, ...listRegisteredCacheableExceptions(), ...sdkCacheable]));
  }
  app.use('*', cachePolicy({ extraExceptions: sdkCacheable, licenseHeader: options.ctx?.env?.APPS_LICENSE_HEADER }));

  // Shutdown step 1 ("stop admitting"): answered before anything else runs.
  if (admit) {
    app.use('*', async (c, next) => {
      if (!admit()) {
        c.header('Connection', 'close');
        c.header('Retry-After', '5');
        return c.json({ error: { code: 'SHUTTING_DOWN', message: 'The server is shutting down. Please retry shortly.' } }, 503);
      }
      await next();
    });
  }

  // OBS-1: request-id FIRST so every downstream middleware (CORS, CSRF, route
  // handlers, onError) sees the same id, and so the access log + error log
  // share one correlatable token. Trust inbound `x-request-id` if it looks
  // safe, otherwise mint a uuid. Always echo the header back on the response.
  app.use('*', requestIdMiddleware());

  // OBS-1: per-request access log. One JSON line per request with method,
  // path, status, duration_ms — emitted at the end so all three values are
  // known. Stays behind the request-id middleware so the line carries it.
  app.use('*', accessLogMiddleware());

  // Plugin pre-route response policy (plugins.ts `errorPolicy`); no-op without one.
  app.use('*', preRoutePolicy(listApiPlugins));
  // OPS-1: per-store CORS allowlist. No wildcard-with-credentials (browsers
  // reject that combination anyway, but we never even offer it). An origin is
  // allowed only when its hostname matches a configured store host
  // (store.config.hostnames — the same registry host->store routing reads) or
  // a small always-on dev allowlist. Mounted before all other middleware so
  // OPTIONS preflights short-circuit ahead of the CSRF guards below.
  //
  // Wrapped in a plain middleware (rather than passing an async function
  // straight to cors()'s `origin` option) to sidestep any ambiguity over
  // whether that option's type signature supports an async callback — the DB
  // lookup is awaited here, then a synchronous per-request cors() instance is
  // built with the resolved verdict.
  app.use('*', async (c, next) => {
    // Plugin data can replace CORS only on validated, exact, non-engine paths. No plugin hook moves ahead of guards.
    const exactPolicy = corsPolicies.size ? corsPolicies.get(new URL(c.req.url).pathname) : undefined;
    if (exactPolicy) {
      if (c.req.method === 'OPTIONS' && exactPolicy.options === 'respond-204') c.res = c.body(null, 204);
      else await next();
      normalizeExactRouteCorsResponse(c, exactPolicy);
      return c.res;
    }
    const origin = c.req.header('origin');
    // P2: the credentialed admin API only answers CORS for EXACT configured origins (cors-origins.ts).
    const allowed = !origin ? false
      : c.req.path === '/v1/admin' || c.req.path.startsWith('/v1/admin/') ? isAllowedAdminCorsOrigin(origin)
      : await isAllowedCorsOrigin(origin);
    const handler = cors({
      origin: allowed ? (origin as string) : '',
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'x-store-slug', 'x-receipt-token', 'idempotency-key'],
    });
    return handler(c, next);
  });

  // WS-E: maintenance-mode gate. During an appliance update the sellright
  // CLI flips the flag file (see maintenance.ts) before touching the
  // database. Reads and the health/readiness/maintenance probes always pass
  // through — only mutating /v1/* requests are rejected, with 503 (not 403 or
  // 400: this is "come back later", not a client error) so callers retry.
  // Registered before the CSRF guards so a maintenance response never depends
  // on cookie state.
  app.use('/v1/*', async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    const alwaysAllowed = path === '/v1/health' || path === '/v1/readyz' || path === '/v1/maintenance';
    const isSafeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    if (!alwaysAllowed && !isSafeMethod && isMaintenanceOn()) {
      return errJson(c, 503, 'MAINTENANCE', 'The store is temporarily unavailable for maintenance. Please try again shortly.', { extra: { maintenance: true } });
    }
    await next();
  });

  // P2: every /v1/admin request must carry a credential (session cookie or Authorization bearer) BEFORE any body is
  // parsed or validated — an anonymous caller learns nothing from validation errors and costs no body parsing.
  // Pre-session routes are exempt; the cache-purge route authenticates with its own shared-token header.
  app.use('/v1/admin/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const p = c.req.path;
    const preSession = p === '/v1/admin/login' || p === '/v1/admin/logout' || p === '/v1/admin/staff/accept'
      // Passkeys (0108): pre-session ceremony + capability probe, treated exactly like /v1/admin/login.
      || p === '/v1/admin/capabilities' || p === '/v1/admin/passkeys/login/options' || p === '/v1/admin/passkeys/login/verify'
      // Issue #333: sign-in step 2, the sign-in screens' store branding and the forgot/reset password pair — same posture.
      || p === '/v1/admin/login/2fa' || p === '/v1/admin/branding' || p === '/v1/admin/password/forgot' || p === '/v1/admin/password/reset' || p === '/v1/admin/password/reset/check';
    // A credential means a parsable Bearer token or the session cookie — not any Authorization header (e.g. Basic).
    const hasCredential = !!bearer(c.req.header('authorization')) || !!cookie(c, SESSION_COOKIE)
      || (p === '/v1/admin/cache/purge' && !!c.req.header(CACHE_ADMIN_TOKEN_HEADER));
    if (!preSession && !hasCredential) return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    await next();
  });

  // Image admission must wrap bodyLimit & OpenAPI multipart validation: both can buffer before the handler.
  app.use('/v1/admin/assets', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    if (!csrfValid(c)) return errJson(c, 403, 'CSRF_INVALID', 'CSRF token missing or invalid');
    return assetUploadAdmission(c, next);
  });

  // P2: app-wide request body cap (API_BODY_LIMIT_BYTES, default 2 MiB). The admin asset upload keeps its own
  // larger cap (routes/admin-assets.ts, 10 MiB + multipart overhead). Over the limit: 413 before any handler.
  const tooLarge = (c: Parameters<Parameters<typeof app.use>[1]>[0]) => errJson(c, 413, 'PAYLOAD_TOO_LARGE', 'request body too large');
  const defaultLimit = bodyLimit({ maxSize: env.API_BODY_LIMIT_BYTES, onError: tooLarge });
  const uploadLimit = bodyLimit({ maxSize: ASSET_UPLOAD_LIMIT_BYTES, onError: tooLarge });
  app.use('*', (c, next) => {
    // Hono's routing path decodes escapes; upload admission must use the original encoded pathname.
    const path = streamBodyLimits.length ? new URL(c.req.url).pathname : '';
    const streamed = streamBodyLimits.find(({ policy }) => matchesNumericRouteBodyLimit(policy, c.req.method, path));
    if (streamed) return streamed.middleware(c, next);
    return (c.req.method === 'POST' && c.req.path === '/v1/admin/assets' ? uploadLimit : defaultLimit)(c, next);
  });

  // P2: validation failures on the admin API answer the generic error envelope (no raw zod issue dump).
  app.use('/v1/admin/*', async (c, next) => {
    await next();
    if (c.res.status !== 400 || !(c.res.headers.get('content-type') ?? '').includes('application/json')) return;
    const body = await c.res.clone().json().catch(() => null) as { success?: boolean; error?: { name?: string; message?: string; issues?: Array<{ path?: unknown[] }> } } | null;
    if (body?.success === false && body.error?.name === 'ZodError') {
      // zod 4 serializes the issues into `message` (a JSON array); older shapes carry `issues`.
      let issues = body.error.issues;
      if (!issues && body.error.message) { try { issues = JSON.parse(body.error.message) as Array<{ path?: unknown[] }>; } catch { /* no param */ } }
      const param = issues?.[0]?.path?.map(String).join('.') || undefined;
      // Keep the headers earlier middleware set on the response (CORS, request id, cache policy).
      const keep = [...c.res.headers.entries()].filter(([k]) => k !== 'content-type' && k !== 'content-length');
      c.res = undefined as unknown as Response; // replace the validator's response
      c.res = c.json(errorEnvelope(c, 'VALIDATION_ERROR', 'invalid request', { param }), 400);
      for (const [k, v] of keep) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    }
  });

  // P2: the full contract (admin routes included) is not published to anonymous callers in production.
  app.use('/v1/openapi.json', openapiAdminOnly(() => env.NODE_ENV === 'production'));

  // CSRF guard for cookie-based admin mutations (bearer/API clients are exempt;
  // login/logout don't yet have a session). Double-submit token (x-csrf-token
  // must match the sr_csrf cookie). Registered before routes.
  app.use('/v1/admin/*', async (c, next) => {
    const m = c.req.method;
    if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
      const p = c.req.path;
      // SEC-OWNER-2: /v1/admin/staff/accept is deliberately public (see
      // admin-settings-advanced.ts) — a brand-new invitee has no admin session
      // yet, so no sr_csrf cookie exists to double-submit. The invite token
      // itself (hashed, single-use, expiry-checked in the handler) is the
      // isolation there, exactly like login/logout before a session exists.
      // Cache purge is machine-only: its handler requires the explicit shared-token header
      // even when a session cookie is present. Keep this exception to the exact POST path.
      const machineCachePurge = m === 'POST' && new URL(c.req.url).pathname === '/v1/admin/cache/purge';
      const exempt = p === '/v1/admin/login' || p === '/v1/admin/logout' || p === '/v1/admin/staff/accept' || machineCachePurge
        || p === '/v1/admin/passkeys/login/options' || p === '/v1/admin/passkeys/login/verify' // passkeys (0108): pre-session, no CSRF cookie yet
        || p === '/v1/admin/login/2fa' || p === '/v1/admin/password/forgot' || p === '/v1/admin/password/reset' || p === '/v1/admin/password/reset/check'; // #333: pre-session
      if (!exempt && !csrfValid(c)) return errJson(c, 403, 'CSRF_INVALID', 'CSRF token missing or invalid');
    }
    await next();
  });

  // Agent seats (docs/plans/2026-10-10-agent-role-v5.md): resolves the admin principal once and applies the
  // agent deny set (auth/agent-policy.ts) before any handler runs. After CSRF so cookie mutations are still CSRF-checked.
  // P1c: the route context (engine-owned routes + plugin agent policies) is filled in once plugins are mounted below.
  let agentRouteContext: AgentRouteContext | undefined;
  app.use('/v1/admin/*', createAdminAgentGuard(() => agentRouteContext));

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
        // Passkeys (0108): public ceremony routes, like login.
        p === '/v1/shop/auth/passkey/login/options' ||
        p === '/v1/shop/auth/passkey/login/verify' ||
        // Pre-session token endpoints (WP2d) — no customer cookie exists yet.
        p === '/v1/shop/auth/forgot-password' ||
        p === '/v1/shop/auth/reset-password' ||
        p === '/v1/shop/auth/verify-email';
      if (!exempt && getCustomerSessionToken(c) && !customerCsrfValid(c)) {
        return errJson(c, 403, 'CSRF_INVALID', 'CSRF token missing or invalid');
      }
    }
    await next();
  });

  // Plugin hooks run only after credential, CSRF & agent guards. Track their entries separately so
  // preRoute handlers never become engine-owned routes in the agent policy snapshot.
  const routesBeforePreRoute = app.routes.length;
  for (const plugin of sdkPlugins) plugin.preRoute?.(app, options.ctx!);
  const preRouteEntries = new Set(app.routes.slice(routesBeforePreRoute));

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

  app.openapi(healthRoute, (c) => c.json({ status: 'ok' as const, version: SELLRIGHT_VERSION }));

  // WS-E: polled by the storefront (WS-C runtime config) to decide whether to
  // render its normal pages or a static "back soon" screen. Deliberately
  // outside the /v1/admin and /v1/shop trees (no CSRF/session requirement —
  // it must be readable while the storefront itself has no session yet) and
  // exempt from the maintenance gate above so it answers even mid-maintenance.
  const maintenanceRoute = createRoute({
    method: 'get',
    path: '/v1/maintenance',
    summary: 'Maintenance-mode status (WS-E)',
    responses: {
      200: {
        description: 'Current maintenance status',
        content: {
          'application/json': {
            schema: z.object({
              maintenance: z.boolean(),
              since: z.string().optional(),
              reason: z.string().optional(),
            }),
          },
        },
      },
    },
  });

  app.openapi(maintenanceRoute, (c) => c.json(maintenanceInfo(), 200));

  // OBS-2: readiness probe distinct from /v1/health. Cheaper probes (LB /
  // deploy) can hit /v1/health; the readiness probe actually asks the DB
  // "can you serve traffic right now?" via SELECT 1 with a short timeout so
  // a hung DB doesn't stall the probe. Failures are sanitized — we never
  // leak credentials, query text, or driver error strings to the client.
  const readyzRoute = createRoute({
    method: 'get',
    path: '/v1/readyz',
    summary: 'Readiness probe (DB ping)',
    responses: {
      200: {
        description: 'Service is ready',
        content: {
          'application/json': {
            schema: z.object({
              status: z.literal('ok'),
              db: z.literal('ok'),
              pools: z.record(z.string(), z.object({ max: z.number().int(), total: z.number().int(), idle: z.number().int(), waiting: z.number().int() })).optional(),
            }),
          },
        },
      },
      503: {
        description: 'Service is not ready',
        content: {
          'application/json': {
            schema: z.object({
              status: z.literal('unavailable'),
              db: z.literal('error'),
              pools: z.record(z.string(), z.object({ max: z.number().int(), total: z.number().int(), idle: z.number().int(), waiting: z.number().int() })).optional(),
            }),
          },
        },
      },
    },
  });

  app.openapi(readyzRoute, async (c) => {
    // The probe runs on the small locks pool (#358 / #360), so it neither queues
    // behind shoppers on a saturated request pool nor takes a connection from
    // them, and it reports every pool's counts so saturation is visible before
    // it turns into connect timeouts. At most ONE probe query is in flight per
    // process (#360 N6): a probe that times out keeps running and every probe
    // until it settles shares it, so repeated probes against a stuck database
    // never pile up waiters. 1 s ceiling per request; the timer is always cleared.
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        readinessProbe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('readiness probe timeout')), 1000);
        }),
      ]);
      // pg.Result rowCount sanity — a healthy round-trip returns exactly
      // one row. Cheap canary against a buggy driver that resolves 0 rows.
      const rowCount = (result as { rowCount?: number | null }).rowCount ?? 0;
      if (rowCount < 1) {
        // eslint-disable-next-line no-console
        console.error('[readyz] SELECT 1 returned no rows');
        return c.json({ status: 'unavailable' as const, db: 'error' as const, pools: poolGauges() }, 503);
      }
      return c.json({ status: 'ok' as const, db: 'ok' as const, pools: poolGauges() }, 200);
    } catch (err) {
      // SEC-5 parity: log full detail server-side, never echo to client.
      // eslint-disable-next-line no-console
      console.error('[readyz] db ping failed', err);
      return c.json({ status: 'unavailable' as const, db: 'error' as const, pools: poolGauges() }, 503);
    } finally {
      clearTimeout(timer);
    }
  });

  app.onError((err, c) => {
    // OBS-1: structured error log — pino's stdErrorSerializer formats the
    // stack + cause chain, which a raw `console.error(err)` can't. The
    // requestId (set by requestIdMiddleware) lets you grep one failing
    // request and see the full handler log story too.
    logErr.error('api error', err, { requestId: c.var?.requestId });

    // HttpError is the explicit route-level contract for safe client errors.
    // Honor it even when a route is not wrapped in guard(); otherwise a route
    // that correctly throws 400/409/etc. is silently flattened to 500.
    if (err instanceof ImportedFinancialReconciliationError) return c.json(errorEnvelope(c, err.code, err.message), err.status);
    if (err instanceof HttpError) {
      return c.json(errorEnvelope(c, err.code, err.message, { param: err.param, extra: err.extra }), err.status);
    }
    // Hono's own request-body errors (e.g. the JSON validator on malformed input) are HTTPExceptions with a 4xx status:
    // answer them with the safe envelope, never as a 500.
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      return c.json(errorEnvelope(c, err.status === 400 ? 'INVALID_JSON' : 'BAD_REQUEST', err.status === 400 ? 'request body is not valid JSON' : 'bad request'), err.status as 400);
    }
    // P2: a schema .parse() inside a handler (e.g. /v1/licenses/*) is a client error, not a 500.
    const zodIssues = (err as { name?: string; issues?: Array<{ path?: PropertyKey[] }> }).name === 'ZodError' ? (err as { issues?: Array<{ path?: PropertyKey[] }> }).issues : undefined;
    if (Array.isArray(zodIssues)) {
      return c.json(errorEnvelope(c, 'VALIDATION_ERROR', 'invalid request', { param: zodIssues[0]?.path?.map(String).join('.') || undefined }), 400);
    }
    // A malformed JSON body read with c.req.json() inside a handler is also the client's error.
    if (err instanceof SyntaxError && /JSON/i.test(err.message)) {
      return c.json(errorEnvelope(c, 'INVALID_JSON', 'request body is not valid JSON'), 400);
    }

    // #358 / #360: no pooled connection freed up in time. The request is fine and
    // so is the API; the database is busy. Say so (503 + Retry-After) instead of
    // a 500, so clients and proxies back off and retry.
    if (isPoolTimeout(err)) {
      c.header('Retry-After', '2');
      return c.json(errorEnvelope(c, 'SERVICE_BUSY', 'the service is busy; retry shortly'), 503);
    }

    // SEC-5: gated on an explicit DEBUG_ERRORS opt-in, not NODE_ENV — a staging
    // box booted without NODE_ENV=production must still sanitize error bodies
    // by default. Server-side logging above still captures the real error.
    const expose = env.DEBUG_ERRORS === '1';
    // OPS-1: honor a well-known httpStatus on routing errors (StoreSlugError,
    // HostRoutingError — both 404, never sensitive) instead of flattening every
    // thrown error to 500. Any error without this field keeps 500 behavior.
    const knownStatus = (err as { httpStatus?: unknown }).httpStatus;
    const status = knownStatus === 404 ? 404 : 500;
    const message = status === 404
      ? (err instanceof Error ? err.message : 'not found')
      : (expose && err instanceof Error ? err.message : 'internal error');
    const code = status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR';
    return c.json(errorEnvelope(c, code, message), status);
  });

  // Shop catalog read API (store resolved per-request, RLS-scoped).
  app.route('/', catalog);
  app.route('/', cart);
  app.route('/', checkout);
  app.route('/', pay);
  app.route('/', gatewayPayments);
  app.route('/', adminGatewayPayments);
  app.route('/', auth);
  app.route('/', shopPasskeys); // 0108: passkeys (customers): login ceremony, management grants, enrolment
  app.route('/', shopConfig);
  app.route('/', customerTokens);
  app.route('/', account);
  app.route('/', accountReturns); // customer-side return requests (the merchant side is admin-orders.ts)
  app.route('/', loyalty); // LOYALTY-1: customer points balance (redeem happens in checkout)
  app.route('/', reviews); // REWARDS-1: product reviews (list + submit)
  app.route('/', orders);
  app.route('/', paymentWebhooks); // WP3: inbound Stripe webhooks (signature-auth, no CSRF/cookie)
  app.route('/', storeKitWebhooks); // Apple StoreKit: App Store Server Notifications + pro/link-storekit
  app.route('/', feeds); // PAR-2: public per-store merchant feeds (google/facebook/pinterest CSV)
  app.route('/', sheeridRoutes); // PAR-4: SheerID verification lifecycle + webhook + admin config
  app.route('/', disputeRoutes); // PAR-7: NMI chargeback webhook + admin dispute list
  app.route('/', apps); // software licenses, app update manifests, admin app releases
  app.route('/', wellKnown); // Apple AASA for iOS Password AutoFill (env-gated)
  app.route('/', subscriptions); // recurring billing: shop subscribe/portal + admin list
  app.route('/', seo); // SEO-1: sitemaps, robots.txt, JSON-LD, IndexNow key-file (generic, per-store)
  app.route('/', cacheVersion); // SEO-1: live per-store cache-invalidation token
  app.route('/', adminCache); // internal Cloudflare cache-purge route (shared-token auth, not an admin session)

  // Admin API — operator surface (auth, dashboard, orders, products, customers).
  app.route('/', admin);
  app.route('/', setup); // one-click install: pre-auth claim (404s once claimed)
  app.route('/', adminSystem); // one-click install: setup checklist, Publish readiness, recovery-kit download
  app.route('/', adminSystemInfo); // read-only build-info + effective-config (config/v1) — owner only
  app.route('/', adminDashboard); // store dashboard KPIs
  app.route('/', adminProducts); // product list/detail/edit + variant pricing/stock
  app.route('/', adminCatalog); // catalog mgmt: product/variant create+delete, collections, inventory
  app.route('/', adminOrders); // orders++: refunds, draft orders, abandoned carts
  app.route('/', adminOrderEdit); // G13/G5: Shopify-style edit of paid orders + direct address edit
  app.route('/', adminOrderOps); // draft orders, tracking import, export, bulk order operations
  app.route('/', adminMarketing); // promotions manager + Listmonk integration
  app.route('/', adminSettings); // store/tax, payments, shipping, staff/roles, notifications
  app.route('/', adminSecurity); // P1b: 2FA enrolment + recovery codes, password change, per-store 2FA requirement
  app.route('/', adminPasskeys); // 0108: passkeys (admin): capabilities + login ceremony (pre-session), enrolment, step-up
  app.route('/', adminLoyalty); // LOYALTY-1: points program settings, customer ledger, manual adjust
  app.route('/', adminReviews); // REWARDS-1: review moderation + settings
  app.route('/', adminPaymentSettings); // WS-A: encrypted per-store payment credentials, verify, Stripe webhook auto-create
  app.route('/', adminEmailSettings); // WS-A: encrypted per-store SMTP settings, presets, test send
  app.route('/', adminSettingsAdvanced); // webhooks, staff, currency rates
  app.route('/', adminReports); // customers write, reports, search, activity
  app.route('/', adminAffiliate); // affiliate program + public self-serve dashboard
  app.route('/', adminContent); // blog CMS admin
  app.route('/', adminAssets); // WP8: asset upload + management
  app.route('/', adminPush); // mobile push: device registration (0039)
  app.route('/', adminLicenses); // mint/list software licenses (comp/support/creator, audited)
  app.route('/', adminAgents); // agent seats: API-token identities with ordinary roles (deny set in auth/agent-policy.ts)
  app.route('/', shopExtra); // shop: guest tracking, public blog, shipping eligibility, newsletter
  app.route('/', subscriberRoutes); // subscriber confirm + unsubscribe (SUBSCRIBER-1)
  app.route('/', adminSeo); // SEO-1: admin SEO config + admin-triggered IndexNow submit
  app.route('/', adminWaitlist); // G10: waitlist demand report + CSV

  // SDK plugin routes are resolved once here (a function-valued `routes` is called exactly once) and
  // mounted after the built-ins below. Legacy `ApiPlugin`s and SDK `EnginePlugin`s share one
  // release-policy owner list, so both are subject to the same conflict check and host.
  const sdkRoutes = sdkPlugins.map((p) => (typeof p.routes === 'function' ? p.routes(options.ctx!) : p.routes));
  const sdkOwners: PolicyOwner[] = sdkPlugins.map((p, i) => ({ name: p.name, releaseRegistration: p.releaseRegistration, routes: sdkRoutes[i] }));
  const policyOwners = (): PolicyOwner[] => [...listApiPlugins(), ...sdkOwners];

  // Release registration policy host (docs/policies/RELEASE-REGISTRATION.md):
  // engine-owned POST /v1/admin/apps/releases; fails startup on plugin conflicts.
  assertNoReleaseRegistrationConflicts(policyOwners());
  app.route('/', createReleaseRegistrationRoutes(policyOwners));
  const releaseHostRouteEntries = hostRouteEntryCount(app);

  // Extension seam (plugins.ts): mounted AFTER every built-in route above, so a
  // plugin path never shadows a built-in one on an exact-path conflict. Empty
  // by default — nothing is registered unless a fork calls registerApiPlugin()
  // from its own entrypoint before createApp() runs.
  // StoreKit fallback policy (sellright-default) is installed before plugins run, so a plugin's
  // init() registers its own appKey policy (ApiPlugin.init, STOREKIT §3). A plugin may not add a second fallback.
  installDefaultStoreKitPolicy();
  // Payment policy (sellright-default, allow-all) before plugins: a plugin's init() registers its own policy.
  installDefaultPaymentPolicy();
  // P1c: every route registered so far is engine-owned; anything mounted from here on belongs to a plugin and is
  // denied to agents for mutations unless the plugin allowlists it (auth/agent-policy.ts).
  const builtinRoutes = new Set(app.routes.filter((r) => r.method !== 'ALL' && !preRouteEntries.has(r)).map((r) => `${r.method.toUpperCase()} ${r.path}`));
  for (const plugin of listApiPlugins()) {
    if (plugin.routes) app.route('/', plugin.routes);
  }
  for (const routes of sdkRoutes) {
    if (routes) app.route('/', routes);
  }
  for (const plugin of listApiPlugins()) {
    plugin.init?.(app);
  }
  assertHostRouteUnshadowed(app, releaseHostRouteEntries); // a plugin must not register the host-owned route from init() either
  agentRouteContext = buildAgentRouteContext(builtinRoutes, [
    ...listApiPlugins().map((p) => ({ name: p.name, policy: p.agentPolicy })),
    ...sdkPlugins.map((p) => ({ name: p.name, policy: p.agentPolicy })),
  ]);

  // Register the stable shop-facing error codes as their own named schema
  // (see api-error.ts's SHOP_API_ERROR_CODES) so a generated client gets a
  // real `ApiErrorCode` union in components.schemas instead of `string`.
  app.openAPIRegistry.register('ApiErrorCode', apiErrorCodeSchema());

  // Published API contract — the product surface (versioned under /v1).
  app.doc('/v1/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'SellRight API', version: SELLRIGHT_VERSION },
  });

  return app;
}

/** @deprecated Legacy name for the Hono builder (kept so existing tests/callers are unchanged). Use the SDK `createApp` from `@sellright/api`. */
export const createApp = buildHttpApp;
