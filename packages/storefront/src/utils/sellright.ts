/**
 * SellRight REST client (replaces the Vendure GraphQL requester for the dynamic
 * paths). SSR fetches the API directly (localhost:3300 on the box); the browser
 * uses relative /v1 paths which vite/the host proxies to the API (no CORS).
 */
import { isServer } from '@qwik.dev/core/build';

const API = import.meta.env.VITE_SELLRIGHT_API_URL || 'http://127.0.0.1:3300';
const STORE_SLUG = import.meta.env.VITE_SELLRIGHT_STORE_SLUG || 'damned';

async function sr<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = isServer ? `${API}${path}` : path;
  const res = await fetch(url, {
    ...init,
    // credentials: 'include' so the auth/CSRF cookies the API sets (sr_session,
    // sr_csrf) ride along on browser calls — auth, account, and the server cart
    // are all cookie-authenticated.
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-store-slug': STORE_SLUG, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const err = new Error(`SellRight ${path} ${res.status}: ${await res.text()}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/** Status code carried on errors thrown by `sr` (for 401/409 branching). */
export const srErrorStatus = (e: unknown): number | undefined =>
  (e as { status?: number } | null)?.status;

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

export const srRegister = (body: { email: string; password: string; firstName?: string; lastName?: string }) =>
  sr<SrAuthResult>('/v1/shop/auth/register', { method: 'POST', body: JSON.stringify(body) });

export const srLogin = (email: string, password: string) =>
  sr<SrAuthResult>('/v1/shop/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const srLogout = () =>
  sr<{ ok: boolean }>('/v1/shop/auth/logout', { method: 'POST', body: JSON.stringify({}) });

export const srMe = () => sr<SrCustomer>('/v1/shop/auth/me');

export const srCheckEmail = (email: string) =>
  sr<{ exists: boolean }>(`/v1/shop/auth/check-email?email=${encodeURIComponent(email)}`);

export const srForgotPassword = (email: string) =>
  sr<{ ok: boolean }>('/v1/shop/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });

export const srResetPassword = (token: string, password: string) =>
  sr<{ ok: boolean }>('/v1/shop/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });

export const srVerifyEmail = (token: string) =>
  sr<{ ok: boolean }>('/v1/shop/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });

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
}
export const srCreateOrder = (body: unknown) =>
  sr<SrCreatedOrder>('/v1/shop/checkout', { method: 'POST', body: JSON.stringify(body) });

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
  lines: { sku: string; name: string; quantity: number; unitPrice: number; lineTotal: number }[];
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
  minPrice: number | null;
  image: string | null;
}

export interface SrSearchResult {
  items: SrProductListItem[];
  total: number;
}

/** GET /v1/shop/catalog/products/{slug} variant. */
export interface SrVariant {
  sku: string;
  name: string;
  price: number;
  salePrice: number | null;
  compareAtPrice: number | null;
  isPreOrder: boolean;
  enabled: boolean;
}

/** GET /v1/shop/catalog/products/{slug} detail. */
export interface SrProductDetail {
  slug: string;
  name: string;
  description: string | null;
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

export interface SrCollection {
  slug: string;
  name: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  products: Array<{ slug: string; name: string; minPrice: number | null }>;
}

export interface SrCollectionsResult {
  items: Array<{ slug: string; name: string; products: number }>;
}

/** GET /v1/shop/catalog/search — term/collection/in-stock filtered, paginated. */
export const srSearch = (params: {
  term?: string;
  collectionSlug?: string;
  take?: number;
  skip?: number;
  inStock?: boolean;
}) => {
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

export const srCollectionBySlug = (slug: string) =>
  sr<SrCollection>(`/v1/shop/collections/${encodeURIComponent(slug)}`);

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
}

/** Absolute line quantities (quantity 0 removes). Matches the cart API's PATCH semantics. */
export type SrCartLineInput = { sku: string; quantity: number };

export const srCreateCart = (body: { items?: SrCartLineInput[]; email?: string; couponCode?: string }) =>
  sr<SrCart>('/v1/shop/cart', { method: 'POST', body: JSON.stringify(body) });

export const srGetCart = (token: string, couponCode?: string) => {
  const q = couponCode ? `?couponCode=${encodeURIComponent(couponCode)}` : '';
  return sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}${q}`);
};

/** PATCH /v1/shop/cart/{token}/lines — ABSOLUTE quantities (not deltas). */
export const srUpdateCartLines = (token: string, lines: SrCartLineInput[], couponCode?: string) =>
  sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}/lines`, {
    method: 'PATCH',
    body: JSON.stringify(couponCode ? { lines, couponCode } : { lines }),
  });

export const srCaptureCartEmail = (token: string, email: string) =>
  sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}`, {
    method: 'PATCH',
    body: JSON.stringify({ email }),
  });

export const srMergeCart = (token: string) =>
  sr<SrCart>(`/v1/shop/cart/${encodeURIComponent(token)}/merge`, { method: 'POST' });
