/**
 * SellRight REST client (replaces the Vendure GraphQL requester for the dynamic
 * paths). SSR fetches the API directly (localhost:3300 on the box, the real
 * merchant API); the browser uses relative /v1 paths which vite/the host
 * proxies to the API (no CORS).
 *
 * Isolated interactive demo (packages/storefront/package.json `build:demo`):
 * VITE_SELLRIGHT_API_URL MUST be set to wherever the demo wrapper
 * (deploy/demo/interactive-server.mjs, DEMO_PORT 4310) is actually bound —
 * DEMO_BIND_HOST 172.22.0.1 (the nginx Docker bridge) once switched to the
 * private proxy path per deploy/demo/README.md, 127.0.0.1 before that switch
 * — never the default 127.0.0.1:3300. Only the wrapper can resolve an
 * incoming request's sr_demo cookie to that visitor's own ephemeral store and dispatch it
 * in-process with the correct x-store-slug; the real API on 3300 has never
 * heard of a store literally named 'demo' (STORE_SLUG's default below) and
 * every SSR-side catalog/PDP/cart call 503s until this is set correctly.
 *
 * WS-C (runtime storefront configuration, plan §1.9): the API base is read
 * from the RUNTIME env var SELLRIGHT_API_URL when present (checked at request
 * time via `process.env`, Node's actual environment — not Vite's build-time
 * `import.meta.env`), falling back to the build-time VITE_SELLRIGHT_API_URL
 * for dev/demo builds and single-store deployments that never set it. This is
 * what lets one built image be pointed at any API instance without a rebuild.
 * Likewise STORE_SLUG (VITE_SELLRIGHT_STORE_SLUG) is now a dev/legacy-single-
 * store fallback ONLY — when unset, the request's own Host is forwarded
 * instead (see sellright-request-host.server.ts) so the API's
 * resolveStoreForRequest resolves the store per-host, exactly like a browser
 * request to that host would.
 */
import { isServer } from '@qwik.dev/core/build';
import { sellrightRequestCookie } from './sellright-request-context.server';
import { sellrightRequestHost } from './sellright-request-host.server';

const BUILD_TIME_API = import.meta.env.VITE_SELLRIGHT_API_URL || 'http://127.0.0.1:3300';
const STORE_SLUG = import.meta.env.VITE_SELLRIGHT_STORE_SLUG || '';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Pure precedence rule, unit-testable without mocking `process`/`import.meta`:
 *  a non-empty runtime override wins, else the build-time value. Trims a
 *  trailing slash either way so callers can safely do `${base}${path}`. */
export function resolveApiBase(runtimeUrl: string | undefined, buildTimeUrl: string): string {
	const runtime = runtimeUrl?.trim();
	return (runtime ? runtime : buildTimeUrl).replace(/\/+$/, '');
}

/** Server-only: the API base for THIS request. `process` only exists in the
 *  Node SSR bundle — never referenced outside an `isServer` branch, so it's
 *  safe alongside the browser bundle (which never evaluates this function).
 *  Exported so other server-only proxies (e.g. sellright-seo.ts's sitemap/
 *  robots/JSON-LD proxy) resolve the SAME API instance `sr()` does, instead
 *  of keeping their own copy of this precedence rule. */
export function apiBase(): string {
	const runtimeUrl = isServer && typeof process !== 'undefined' ? process.env?.SELLRIGHT_API_URL : undefined;
	return resolveApiBase(runtimeUrl, BUILD_TIME_API);
}

/**
 * Server-only: the store-resolution headers for THIS request — `x-store-slug`
 * when a build pins one (dev/demo/legacy single-store), else the incoming
 * request's own Host forwarded as `x-forwarded-host` (WS-C: per-host runtime
 * resolution). Exported so every server-side proxy to the API resolves the
 * SAME store `sr()` does — a proxy with its own hardcoded store slug would
 * silently serve the wrong store's data (or the dev default) on any real
 * multi-store deployment.
 */
export function storeResolutionHeaders(): Record<string, string> {
	if (!isServer) return {};
	const headers: Record<string, string> = {};
	if (STORE_SLUG) headers['x-store-slug'] = STORE_SLUG;
	else {
		const forwardedHost = sellrightRequestHost.getStore();
		if (forwardedHost) headers['x-forwarded-host'] = forwardedHost;
	}
	return headers;
}

/**
 * Double-submit CSRF token, browser-side only. packages/api's shop/admin CSRF
 * guards (app.ts) require `x-csrf-token` to match the readable `sr_csrf`
 * cookie for any mutation once a session cookie exists (customer session on
 * the real API; every visitor on the isolated demo, which has no anonymous
 * "guest checkout" concept — its stricter wrapper CSRF gate checks this on
 * every mutation, session or not). `sr()` never read this cookie at all, so
 * every mutating call 403'd the moment a session existed to protect — most
 * visibly, 100% of isolated-demo checkouts. `sr_csrf` is deliberately NOT
 * HttpOnly (that's the whole point of double-submit: same-origin JS must be
 * able to read it back to prove it isn't a cross-site forgery), so this is
 * exactly what it's for.
 */
function readCsrfCookie(): string | undefined {
  if (isServer || typeof document === 'undefined') return undefined;
  const match = document.cookie.match(/(?:^|;\s*)sr_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function sr<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = isServer ? `${apiBase()}${path}` : path;
  // SSR only: forward the browser's own cookie header so a per-visitor/
  // per-customer session (sr_session, sr_csrf, and the isolated demo's
  // sr_demo/sr_csrf) resolves to the SAME session the browser has, instead of
  // an anonymous server-to-server call. Browser calls already send cookies
  // natively via credentials:'include' below.
  const forwardedCookie = isServer ? sellrightRequestCookie.getStore() : undefined;
  const method = (init.method ?? 'GET').toUpperCase();
  const csrf = !isServer && MUTATING_METHODS.has(method) ? readCsrfCookie() : undefined;
  // Server-only, and only when the caller hasn't already supplied its own
  // `signal`: bound how long an SSR/SSG data load waits on the API. Static
  // generation (`pnpm build`, no API reachable) has no request-timeout
  // backstop otherwise — an unresponsive/slow-to-refuse socket can leave a
  // page's render hanging or resolving at an unpredictable time relative to
  // other in-flight work, which is exactly the kind of timing this function
  // must NOT be sensitive to (every caller's catch block must always run,
  // deterministically, within a bounded window).
  const signal = isServer && !init.signal ? AbortSignal.timeout(8000) : init.signal;
  const res = await fetch(url, {
    ...init,
    signal,
    // credentials: 'include' so the auth/CSRF cookies the API sets (sr_session,
    // sr_csrf) ride along on browser calls — auth, account, and the server cart
    // are all cookie-authenticated.
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...storeResolutionHeaders(),
      ...(forwardedCookie ? { cookie: forwardedCookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    const err = new Error(`SellRight ${path} ${res.status}: ${text}`) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return (await res.json()) as T;
}

/** Status code carried on errors thrown by `sr` (for 401/409 branching). */
export const srErrorStatus = (e: unknown): number | undefined =>
  (e as { status?: number } | null)?.status;

/** Parsed JSON body carried on errors thrown by `sr` (409 conflict payloads). */
export const srErrorBody = <T = unknown>(e: unknown): T | undefined =>
  (e as { body?: T } | null)?.body;

// ─────────────────────────────────────────────────────────────────────────────
// Store identity/theme (WS-C) — mirrors packages/api/src/routes/store-identity.ts
// ─────────────────────────────────────────────────────────────────────────────

export interface SrStoreIdentity {
  storeName: string;
  legalName: string;
  tagline: string;
  supportEmail: string;
  logoText: string;
  logoImageUrl: string | null;
  ogImageUrl: string;
  address: {
    streetAddress: string;
    addressLocality: string;
    addressRegion: string;
    postalCode: string;
    addressCountry: string;
  } | null;
  social: {
    instagram?: string;
    facebook?: string;
    twitter?: string;
    tiktok?: string;
    youtube?: string;
  };
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    border: string;
  };
  fonts: { display: string; body: string; mono: string };
  currency: string;
  locale: string;
  siteOrigin: string;
  published: boolean;
  policies: {
    shipping: { label: string; sub: string };
    returns: { label: string; sub: string };
    payment: { label: string; sub: string };
  };
}

/**
 * GET /v1/shop/identity for the store resolved from this request (per-host in
 * production, STORE_SLUG in dev/demo — see `sr`). `previewToken`, when given,
 * is forwarded as `x-preview-token` so an unpublished store's own owner (or
 * anyone holding the preview link) can still resolve identity; the API 404s
 * (StoreNotPublishedError) for anyone else. Callers (the root route loader)
 * catch that 404 and render a "coming soon" page instead of propagating it.
 */
export const srShopIdentity = (previewToken?: string) =>
  sr<SrStoreIdentity>('/v1/shop/identity', previewToken ? { headers: { 'x-preview-token': previewToken } } : {});

export interface SrMaintenanceStatus {
  maintenance: boolean;
  since?: string;
  reason?: string;
}

/**
 * WS-E: polled on every request alongside identity so the layout can render
 * "back soon" instead of the real storefront chrome while the API is mid
 * update. Deliberately never throws on failure — an unreachable API here
 * should fail open (render the normal page, which will itself fail
 * downstream) rather than mask a real outage as a maintenance screen.
 */
export const srMaintenanceStatus = async (): Promise<SrMaintenanceStatus> => {
  try {
    return await sr<SrMaintenanceStatus>('/v1/maintenance', {});
  } catch {
    return { maintenance: false };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Auth & account — mirrors packages/api/src/routes/{auth,account,customer-tokens}.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Shared customer shape returned by register/login/google/me (CustomerOut). */
export interface SrCustomer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  emailVerified: boolean;
  isMigrated: boolean;
}

export interface SrAuthResult {
  token: string;
  customer: SrCustomer;
}

export const srRegister = (body: { email: string; password: string; firstName?: string; lastName?: string; turnstileToken?: string }) =>
  sr<SrAuthResult>('/v1/shop/auth/register', { method: 'POST', body: JSON.stringify(body) });

export const srLogin = (email: string, password: string, turnstileToken?: string) =>
  sr<SrAuthResult>('/v1/shop/auth/login', { method: 'POST', body: JSON.stringify({ email, password, turnstileToken }) });

export const srLogout = () =>
  sr<{ ok: boolean }>('/v1/shop/auth/logout', { method: 'POST', body: JSON.stringify({}) });

export const srMe = () => sr<SrCustomer>('/v1/shop/auth/me');

export const srCheckEmail = (email: string, turnstileToken?: string, honeypot?: string) => {
  const query = new URLSearchParams({ email });
  if (turnstileToken !== undefined) query.set('turnstileToken', turnstileToken);
  if (honeypot !== undefined) query.set('honeypot', honeypot);
  return sr<{ exists: boolean }>(`/v1/shop/auth/check-email?${query}`);
};

export const srForgotPassword = (email: string) =>
  sr<{ ok: boolean }>('/v1/shop/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });

export const srResetPassword = (token: string, password: string) =>
  sr<{ ok: boolean }>('/v1/shop/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });

export const srVerifyEmail = (token: string) =>
  sr<{ ok: boolean }>('/v1/shop/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });

export const srResendVerification = (email: string) =>
  sr<{ ok: boolean }>('/v1/shop/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });

/** PATCH /v1/shop/account/me — profile (firstName/lastName/phone). */
export const srUpdateProfile = (body: { firstName?: string | null; lastName?: string | null; phone?: string | null }) =>
  sr<{ id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null }>(
    '/v1/shop/account/me',
    { method: 'PATCH', body: JSON.stringify(body) },
  );

/** POST /v1/shop/account/password — change password (verify current first). */
export const srChangePassword = (currentPassword: string, newPassword: string) =>
  sr<{ ok: boolean }>('/v1/shop/account/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });

export interface SrAddress {
  id: string;
  fullName: string | null;
  line1: string;
  line2: string | null;
  city: string;
  province: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}

/** The body for create/update address (id is server-assigned, omitted here). */
export type SrAddressInput = {
  fullName?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  province?: string | null;
  postalCode?: string | null;
  country: string; // ISO-2
  phone?: string | null;
  isDefaultShipping?: boolean;
  isDefaultBilling?: boolean;
};

export const srGetAddresses = () => sr<{ items: SrAddress[] }>('/v1/shop/account/addresses');

export const srCreateAddress = (body: SrAddressInput) =>
  sr<{ id: string }>('/v1/shop/account/addresses', { method: 'POST', body: JSON.stringify(body) });

export const srUpdateAddress = (id: string, body: Partial<SrAddressInput>) =>
  sr<{ ok: boolean }>(`/v1/shop/account/addresses/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });

export const srDeleteAddress = (id: string) =>
  sr<{ ok: boolean }>(`/v1/shop/account/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ─────────────────────────────────────────────────────────────────────────────
// Account orders — mirrors packages/api/src/routes/account.ts
// ─────────────────────────────────────────────────────────────────────────────

export interface SrAccountOrderSummary {
  code: string;
  state: string;
  grandTotal: number;
  placedAt: string | null;
  lines: number;
}

export interface SrAccountOrderDetail {
  code: string;
  state: string;
  grandTotal: number;
  lines: { sku: string; name: string; quantity: number; lineTotal: number }[];
}

export const srAccountOrders = () => sr<{ items: SrAccountOrderSummary[] }>('/v1/shop/account/orders');

export const srAccountOrder = (code: string) =>
  sr<SrAccountOrderDetail>(`/v1/shop/account/orders/${encodeURIComponent(code)}`);

// ─────────────────────────────────────────────────────────────────────────────
// Shipping / currencies / newsletter — shop-extra.ts + catalog.ts
// ─────────────────────────────────────────────────────────────────────────────

export interface SrShippingMethod {
  code: string;
  name: string;
  rate: number;
}

export const srShippingMethods = (country?: string, subtotal = 0) => {
  const q = new URLSearchParams();
  if (country) q.set('country', country);
  q.set('subtotal', String(subtotal));
  return sr<{ methods: SrShippingMethod[] }>(`/v1/shop/shipping-methods?${q.toString()}`);
};

export const srCurrencies = () =>
  sr<{ base: string; currencies: { currency: string; rate: number }[] }>('/v1/shop/currencies');

export const srNewsletterSignup = (email: string, name?: string) =>
  sr<{ ok: boolean }>('/v1/shop/newsletter-signup', { method: 'POST', body: JSON.stringify(name ? { email, name } : { email }) });

export interface SrCreatedOrder {
  code: string; state: string; grandTotal: number; currency: string;
  // Checkout-migration: discountTotal / coupon / gift-card / receipt token. The
  // receiptToken scopes the public confirmation read (carried as ?rt=).
  discountTotal?: number; couponApplied?: boolean; giftCardApplied?: number; receiptToken?: string;
  /** Points spent on this order and the discount they bought (cents). */
  pointsRedeemed?: number; pointsDiscount?: number;
}
export const srCreateOrder = (body: unknown, opts?: { idempotencyKey?: string }) =>
  sr<SrCreatedOrder>('/v1/shop/checkout', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: opts?.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : undefined,
  });

export const srPayOrder = (code: string, method = 'cod') =>
  sr<{ code: string; state: string; payment: string }>(`/v1/shop/orders/${encodeURIComponent(code)}/pay`, {
    method: 'POST', body: JSON.stringify({ method }),
  });

// ── Stripe checkout-migration (behind VITE_SR_CHECKOUT) ──────────────────────

/** POST /v1/shop/orders/{code}/payment-intent → a Stripe PaymentIntent's
 *  client_secret (idempotent server-side on the order). Mount the Payment
 *  Element against this secret and confirm client-side. */
export const srCreatePaymentIntent = (code: string) =>
  sr<{ clientSecret: string; intentId: string }>(`/v1/shop/orders/${encodeURIComponent(code)}/payment-intent`, {
    method: 'POST', body: JSON.stringify({}),
  });

/** GET /v1/shop/stripe-key → the mode-appropriate publishable key (public). */
export const srStripePublishableKey = () =>
  sr<{ publishableKey: string | null }>('/v1/shop/stripe-key');

export interface SrOrder {
  code: string; state: string; currency: string;
  subtotal: number; shippingTotal: number; taxTotal: number; discountTotal: number; grandTotal: number;
  placedAt: string | null; shippingAddress: unknown;
  customerEmail: string | null;
  lines: { sku: string; name: string; quantity: number; unitPrice: number; lineTotal: number; image: string | null }[];
}
/** GET /v1/shop/orders/{code} — receipt read. Scoped: pass the receipt token
 *  (`rt`, from srCreateOrder) OR be the authed owner; a bare code is denied. */
export const srGetOrder = (code: string, rt?: string) => {
  const q = rt ? `?rt=${encodeURIComponent(rt)}` : '';
  return sr<SrOrder>(`/v1/shop/orders/${encodeURIComponent(code)}${q}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Catalog — raw REST shapes (mirrors packages/api/src/routes/catalog.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /v1/shop/catalog/search & /catalog/products list item. Prices in integer minor units. */
export interface SrProductListItem {
  slug: string;
  name: string;
  status: string;
  inStock?: boolean;
  tags?: string[] | null;
  minPrice: number | null;
  pricingVariant?: Pick<SrVariant, 'sku' | 'price' | 'salePrice' | 'preOrderPrice' | 'isPreOrder' | 'shipDate'> | null;
  image: string | null;
}

export interface SrSearchResult {
  items: SrProductListItem[];
  total: number;
}

export const srAssetUrl = (path: string) => /^(https?:\/\/|\/)/.test(path) ? path : `/assets/${path}`;

/** GET /v1/shop/catalog/products/{slug} variant. */
export interface SrVariant {
  sku: string;
  name: string;
  price: number;
  salePrice: number | null;
  preOrderPrice: number | null;
  shipDate: string | null;
  compareAtPrice: number | null;
  isPreOrder: boolean;
  enabled: boolean;
  options?: { id: string; code: string; name: string; group: { id: string; code: string; name: string } }[];
}

/** GET /v1/shop/catalog/products/{slug} detail. */
export interface SrProductDetail {
  slug: string;
  name: string;
  description: string | null;
  tags?: string[] | null;
  status: string;
  seoTitle: string | null;
  seoDescription: string | null;
  currency: string;
  images: string[];
  variants: SrVariant[];
}

export interface SrStockResult {
  variants: { sku: string; inStock: boolean }[];
}

export interface SrBlogPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  readingTime: number | null;
  authorName: string | null;
  featuredAsset: { id: string; path: string } | null;
  tags: string[] | null;
  publishDate: string | null;
}

export interface SrBlogDetail extends SrBlogPost {
  bodyHtml: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

export const srBlogPosts = (take = 20, skip = 0) =>
  sr<{ items: SrBlogPost[]; totalItems: number }>(`/v1/shop/blog?${new URLSearchParams({ take: String(take), skip: String(skip) })}`);

export const srBlogPost = (slug: string) => sr<SrBlogDetail>(`/v1/shop/blog/${encodeURIComponent(slug)}`);

export interface SrCollection {
  slug: string;
  name: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  // Same per-product shape as catalog/search & catalog/products (image +
  // inStock computed live from stock_level, no cache) — full ProductCard
  // tile parity on the collection page.
  products: Array<Pick<SrProductListItem, 'slug' | 'name' | 'minPrice' | 'image' | 'inStock' | 'pricingVariant'>>;
}

export interface SrCollectionsResult {
  items: Array<{ slug: string; name: string; products: number }>;
}

/** GET /v1/shop/catalog/search — term/collection/in-stock filtered, paginated. */
export const srSearch = async (params: {
  term?: string;
  collectionSlug?: string;
  take?: number;
  skip?: number;
  inStock?: boolean;
}): Promise<SrSearchResult> => {
  // Existing consumers request up to 500 items; the API caps each page at 100.
  if ((params.take ?? 24) > 100) {
    const items: SrProductListItem[] = [];
    const take = Math.min(params.take!, 10000);
    let total = 0;
    while (items.length < take) {
      const page: SrSearchResult = await srSearch({ ...params, take: Math.min(100, take - items.length), skip: (params.skip ?? 0) + items.length });
      total = page.total;
      if (!page.items.length && (params.skip ?? 0) + items.length < total) throw new Error('Incomplete catalog page');
      items.push(...page.items);
      if ((params.skip ?? 0) + items.length >= total) break;
    }
    return { items, total };
  }
  const q = new URLSearchParams();
  // The search endpoint requires a non-empty term (min length 1). When the caller
  // wants the full catalog (empty term), fall back to the plain product list.
  if (params.term && params.term.trim()) {
    q.set('term', params.term.trim());
    if (params.collectionSlug) q.set('collectionSlug', params.collectionSlug);
    if (params.take != null) q.set('take', String(params.take));
    if (params.skip != null) q.set('skip', String(params.skip));
    if (params.inStock != null) q.set('inStock', String(params.inStock));
    return sr<SrSearchResult>(`/v1/shop/catalog/search?${q.toString()}`);
  }
  if (params.take != null) q.set('limit', String(params.take));
  if (params.skip != null) q.set('offset', String(params.skip));
  return sr<SrSearchResult>(`/v1/shop/catalog/products?${q.toString()}`);
};

export const srProductBySlug = (slug: string) =>
  sr<SrProductDetail>(`/v1/shop/catalog/products/${encodeURIComponent(slug)}`);

export const srProductStock = (slug: string) =>
  sr<SrStockResult>(`/v1/shop/catalog/products/${encodeURIComponent(slug)}/stock`);

export const srCollections = () => sr<SrCollectionsResult>('/v1/shop/catalog/collections');

export const srCollectionBySlug = (slug: string, opts: { page?: number; pageSize?: number } = {}) => {
  const q = new URLSearchParams();
  if (opts.page != null) q.set('page', String(opts.page));
  if (opts.pageSize != null) q.set('pageSize', String(opts.pageSize));
  const qs = q.toString();
  return sr<SrCollection & { total: number; page: number; pageSize: number }>(
    `/v1/shop/collections/${encodeURIComponent(slug)}${qs ? `?${qs}` : ''}`,
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Cart — raw REST shapes (mirrors packages/api/src/routes/cart.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface SrCartLine {
  sku: string;
  name: string;
  unitPrice: number;
  quantity: number;
  lineSubtotal: number;
  lineDiscount: number;
  lineTotal: number;
  available: boolean;
}

export interface SrCart {
  token: string;
  status: string;
  email: string | null;
  customerId: string | null;
  currency: string;
  lines: SrCartLine[];
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  unavailable: string[];
  coupon: { code: string; applied: boolean; reason?: string } | null;
  /** Optimistic-concurrency counter — echo back on every non-append mutation. */
  revision: number;
}

/** 409 body from cart/checkout conflicts: the rejection code plus the CURRENT
 *  revision and a freshly re-priced cart snapshot to adopt. */
export interface SrCartConflict {
  error: string;
  code: 'converted' | 'merged' | 'stale' | 'revision_required';
  revision: number;
  cart: SrCart;
}

/** Extract a cart-conflict payload from a thrown `sr` error (409 only). */
export const srCartConflict = (e: unknown): SrCartConflict | null => {
  if (srErrorStatus(e) !== 409) return null;
  const body = srErrorBody<SrCartConflict>(e);
  return body && typeof body.revision === 'number' && body.cart ? body : null;
};

export type SrCartLineInput = { sku: string; quantity: number };

export const srCreateCart = (body: { items?: SrCartLineInput[]; email?: string; couponCode?: string }) =>
  sr<SrCart>('/v1/shop/cart', { method: 'POST', body: JSON.stringify(body) });

export const srGetCart = (token: string, couponCode?: string) => {
  const q = couponCode ? `?couponCode=${encodeURIComponent(couponCode)}` : '';
  return sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}${q}`);
};

/** PATCH /v1/shop/cart/{token}/lines — BLIND APPEND (increment semantics).
 *  Quantities are ADDED server-side; no expectedRevision needed or allowed —
 *  appends commute, so concurrent "add to cart" clicks can't stale-conflict. */
export const srAddCartLines = (token: string, lines: SrCartLineInput[], couponCode?: string) =>
  sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}/lines`, {
    method: 'PATCH',
    body: JSON.stringify(couponCode ? { lines, couponCode } : { lines }),
  });

/** PATCH /v1/shop/cart/{token}/lines — ABSOLUTE SET (quantity 0 removes).
 *  Requires expectedRevision: the server 409s 'revision_required' without it
 *  and 'stale' (plus the current snapshot) when it doesn't match. */
export const srSetCartLines = (token: string, lines: SrCartLineInput[], expectedRevision: number, couponCode?: string) =>
  sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}/lines`, {
    method: 'PATCH',
    body: JSON.stringify({ lines, expectedRevision, ...(couponCode ? { couponCode } : {}) }),
  });

/** Capture the shopper's email — non-append mutation, expectedRevision required. */
export const srCaptureCartEmail = (token: string, email: string, expectedRevision: number) =>
  sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}`, {
    method: 'PATCH',
    body: JSON.stringify({ email, expectedRevision }),
  });

/** Fold the guest cart into the logged-in customer — non-append mutation. */
export const srMergeCart = (token: string, expectedRevision: number) =>
  sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}/merge?expectedRevision=${expectedRevision}`, { method: 'POST' });

// ─────────────────────────────────────────────────────────────────────────────
// Gateway payments — mirrors packages/api/src/routes/{gateway-payments,shop-config,shop-extra}.ts
// ─────────────────────────────────────────────────────────────────────────────

/** GET /v1/shop/config — public runtime config: which tender paths the store
 *  actually has configured (never expose methods that would 409 at payment). */
/** Public points-program terms (GET /v1/shop/config `loyalty`). */
export interface SrLoyaltyProgram {
  enabled: boolean;
  earnRatePerDollar: number;
  pointsPerDollarOff: number;
  minRedeemPoints: number;
  maxRedeemPercentOfSubtotal: number | null;
  expiryDays: number | null;
}

/** GET /v1/shop/account/loyalty — the signed-in customer's points. */
export interface SrAccountLoyalty {
  program: SrLoyaltyProgram;
  currency: string;
  balance: number;
  available: number;
  /** Cents the available points are worth. */
  availableValue: number;
  activity: Array<{ kind: string; points: number; createdAt: string; expiresAt: string | null; orderCode: string | null }>;
}
export const srAccountLoyalty = () => sr<SrAccountLoyalty>('/v1/shop/account/loyalty');

/** Display-only estimate (the server computes the real number at checkout):
 *  points earned on `eligibleCents` of merchandise after discounts. */
export const estimatePointsEarned = (eligibleCents: number, program: SrLoyaltyProgram | null | undefined): number =>
  program?.enabled && eligibleCents > 0 ? Math.floor((Math.floor(eligibleCents) * program.earnRatePerDollar) / 100) : 0;

/** Display-only preview of a redemption, mirroring the server's rules
 *  (cap, minimum, only the points the discount costs). */
export const previewRedemption = (
  requested: number, available: number, discountableCents: number, program: SrLoyaltyProgram | null | undefined,
): { points: number; discountCents: number } | null => {
  if (!program?.enabled || !(requested > 0) || requested > available || requested < program.minRedeemPoints) return null;
  const cap = program.maxRedeemPercentOfSubtotal == null ? discountableCents : Math.floor((discountableCents * program.maxRedeemPercentOfSubtotal) / 100);
  const discountCents = Math.min(Math.floor((requested * 100) / program.pointsPerDollarOff), Math.max(0, cap));
  if (discountCents <= 0) return null;
  const points = Math.min(requested, Math.ceil((discountCents * program.pointsPerDollarOff) / 100));
  return points >= program.minRedeemPoints ? { points, discountCents } : null;
};

export interface SrShopConfig {
  stripeMode: 'test' | 'live';
  stripePublishableKey: string | null;
  stripeConfigured: boolean;
  gateways: {
    /** Present only when the store's NMI account is configured AND carries a
     *  tokenization key — the value Collect.js loads with. */
    nmi: { tokenizationKey: string; mode: 'test' | 'live'; environment?: 'sandbox' | 'production' } | null;
    sezzle: boolean;
  };
  /** Points program terms; null/absent while the program is off. */
  loyalty?: SrLoyaltyProgram | null;
}
export const srShopConfig = () => sr<SrShopConfig>('/v1/shop/config');

export type SrGatewayAttemptStatus = 'pending' | 'processing' | 'settled' | 'declined' | 'failed' | 'unknown';

/** Attempt view returned by POST gateway-payment and POST .../verify.
 *  `checkoutUrl` is present on Sezzle session attempts (shopper redirect). */
export interface SrGatewayAttempt {
  attemptId: string;
  status: SrGatewayAttemptStatus | string;
  checkoutUrl?: string;
  state?: string;
}

/** POST /v1/shop/orders/{code}/gateway-payment — start an NMI charge (with a
 *  Collect.js payment_token) or a Sezzle hosted session. Idempotency-Key is
 *  REQUIRED: one key per shopper attempt; the same key replays the same
 *  attempt instead of double-charging. */
export const srGatewayPayment = (
  code: string,
  body: { method: 'nmi' | 'sezzle'; token?: string },
  opts: { idempotencyKey: string; receiptToken?: string },
) =>
  sr<SrGatewayAttempt>(`/v1/shop/orders/${encodeURIComponent(code)}/gateway-payment`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'idempotency-key': opts.idempotencyKey,
      ...(opts.receiptToken ? { 'x-receipt-token': opts.receiptToken } : {}),
    },
  });

/** POST /v1/shop/orders/{code}/gateway-payment/{attempt}/verify — reconcile an
 *  attempt with the provider (NMI query / Sezzle order fetch). The Sezzle
 *  complete_url carries ?paymentAttempt={id} — the confirmation page calls
 *  this on return before rendering the order state. */
export const srVerifyGatewayPayment = (code: string, attemptId: string, opts: { receiptToken?: string } = {}) =>
  sr<SrGatewayAttempt>(`/v1/shop/orders/${encodeURIComponent(code)}/gateway-payment/${encodeURIComponent(attemptId)}/verify`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: opts.receiptToken ? { 'x-receipt-token': opts.receiptToken } : undefined,
  });

/** POST /v1/shop/contact — honeypot/website fake-success handled server-side;
 *  429 surfaces the retry message in `error`. */
export const srContact = (body: {
  name: string; email: string; subject: string; message: string;
  turnstileToken?: string; honeypot?: string; website?: string;
}) =>
  sr<{ ok: boolean; message?: string }>('/v1/shop/contact', {
    method: 'POST', body: JSON.stringify(body),
  });
