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
    headers: { 'content-type': 'application/json', 'x-store-slug': STORE_SLUG, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`SellRight ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface SrCreatedOrder { code: string; state: string; grandTotal: number; currency: string; }
export const srCreateOrder = (body: unknown) =>
  sr<SrCreatedOrder>('/v1/shop/checkout', { method: 'POST', body: JSON.stringify(body) });

export const srPayOrder = (code: string, method = 'cod') =>
  sr<{ code: string; state: string; payment: string }>(`/v1/shop/orders/${encodeURIComponent(code)}/pay`, {
    method: 'POST', body: JSON.stringify({ method }),
  });

export interface SrOrder {
  code: string; state: string; currency: string;
  subtotal: number; shippingTotal: number; taxTotal: number; discountTotal: number; grandTotal: number;
  placedAt: string | null; shippingAddress: unknown;
  lines: { sku: string; name: string; quantity: number; unitPrice: number; lineTotal: number }[];
}
export const srGetOrder = (code: string) => sr<SrOrder>(`/v1/shop/orders/${encodeURIComponent(code)}`);

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
