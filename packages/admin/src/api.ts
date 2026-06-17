import { maybeMock } from './qa-mocks.js';

// Thin fetch client for the SellRight admin API. Token + active store live in
// localStorage; every request carries the bearer token and x-store-slug header.

// The session token lives in an httpOnly cookie (set by the API on login) — JS
// can't read it, so XSS can't steal it. We send `credentials: 'include'` so the
// browser attaches it. Mutations echo the non-httpOnly CSRF cookie back in a
// header (double-submit). Only the active store slug is kept in localStorage.
const STORE_KEY = 'sr_admin_store';

export const auth = {
  get store() { return localStorage.getItem(STORE_KEY); },
  set store(v: string | null) { v ? localStorage.setItem(STORE_KEY, v) : localStorage.removeItem(STORE_KEY); },
};

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  // QA mock short-circuit — gated by VITE_QA_MOCK + ?qa=1 in qa-mocks.ts.
  // Mutations always pass through so we don't accidentally let QA mode write
  // to the real DB. The mock is at the network boundary, NOT inside pages.
  if (method === 'GET') {
    const qs = new URLSearchParams(path.includes('?') ? path.split('?').pop() || '' : '');
    const pathOnly = path.split('?')[0]!;
    const mock = maybeMock(pathOnly, qs, { method });
    if (mock) {
      if (mock.threw) throw new ApiError(500, mock.threw);
      return mock.data as T;
    }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth.store) headers['x-store-slug'] = auth.store;
  if (method !== 'GET') { const csrf = readCookie('sr_csrf'); if (csrf) headers['x-csrf-token'] = csrf; }
  const res = await fetch(`/v1/admin${path}`, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && !path.startsWith('/login') && location.pathname !== '/login') location.assign('/login');
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  get: <T>(p: string) => req<T>('GET', p),
  post: <T>(p: string, b?: unknown) => req<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => req<T>('PATCH', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => req<T>('PUT', p, b ?? {}),
  del: <T>(p: string) => req<T>('DELETE', p),
};

/** Fetch a file (e.g. CSV export) with auth headers and trigger a download. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (auth.store) headers['x-store-slug'] = auth.store;
  const res = await fetch(`/v1/admin${path}`, { headers, credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, `export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export interface AssetRow { id: string; path: string; url: string; width: number | null; height: number | null; alt: string | null }

/** Upload an image (multipart). The browser sets the multipart boundary, so we
 *  must NOT set content-type here (unlike the JSON `req`). CSRF + store headers
 *  still apply. WP8c. */
export async function uploadAsset(file: File, alt?: string): Promise<AssetRow> {
  const headers: Record<string, string> = {};
  if (auth.store) headers['x-store-slug'] = auth.store;
  const csrf = readCookie('sr_csrf'); if (csrf) headers['x-csrf-token'] = csrf;
  const fd = new FormData();
  fd.append('file', file);
  if (alt) fd.append('alt', alt);
  const res = await fetch('/v1/admin/assets', { method: 'POST', headers, credentials: 'include', body: fd });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `upload failed (${res.status})`);
  return json as AssetRow;
}

// ── shared types ────────────────────────────────────────────────────────────
export interface StoreAccess { storeId: string; slug: string; name: string; currency: string; role: string; }
export interface Me { email: string; stores: StoreAccess[]; }
export interface LoginResp { token?: string; csrfToken?: string; twoFactorRequired?: boolean; admin?: { email: string }; stores?: StoreAccess[]; }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number; }

export interface OrderRow { code: string; state: string; isPreOrder?: boolean; grandTotal: number; currency: string; placedAt: string | null; createdAt: string; email: string | null; }
export interface Dashboard {
  store: { slug: string; name: string; currency: string };
  revenue: number; orders: number; aov: number; pendingFulfillment: number; customers: number; lowStock: number;
  recentOrders: OrderRow[];
}
export interface OrderDetail {
  code: string; state: string; currency: string;
  subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; grandTotal: number;
  placedAt: string | null; createdAt: string;
  shippingAddress: Record<string, unknown> | null; billingAddress: Record<string, unknown> | null;
  customer: { id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null } | null;
  lines: { sku: string; name: string; quantity: number; unitPrice: number; lineTotal: number; fulfilledQty: number; refundedQty: number }[];
  payments: { method: string; amount: number; state: string; providerRef: string | null; createdAt: string }[];
  fulfillments: { id: string; state: string; trackingCode: string | null; carrier: string | null; createdAt: string }[];
  events: { action: string; fromState: string | null; toState: string | null; actor: string | null; at: string }[];
}
export interface ProductRow { id: string; slug: string; name: string; status: string; assetPath: string | null; variants: number; minPrice: number | null; stock: number; }
export interface VariantRow { id: string; sku: string; name: string; price: number; salePrice: number | null; enabled: boolean; onHand: number; allocated: number; available: number; optionIds?: string[]; }
export interface ProductImage { assetId: string; path: string; url: string; position: number; }
export interface ProductDetail { id: string; slug: string; name: string; description: string | null; status: string; assetPath: string | null; featuredAssetId: string | null; images: ProductImage[]; variants: VariantRow[]; }
export interface CustomerRow { id: string; email: string; firstName: string | null; lastName: string | null; createdAt: string; orders: number; spent: number; }
export interface CustomerDetail {
  id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null; emailVerified: boolean; createdAt: string;
  orderCount: number; spent: number;
  addresses: { fullName: string | null; line1: string; line2: string | null; city: string; province: string | null; postalCode: string | null; country: string; phone: string | null }[];
  orders: OrderRow[];
}

export interface CollectionRow { id: string; slug: string; name: string; parentId: string | null; products: number; }
export interface CollectionDetail { id: string; slug: string; name: string; description: string | null; parentId: string | null; products: { id: string; name: string; status: string; position: number }[]; }
export interface InventoryRow { variantId: string; sku: string; name: string; productName: string; onHand: number; allocated: number; available: number; }
export interface StockMovementRow { delta: number; reason: string; refOrderId: string | null; createdAt: string; }

export function assetUrl(path: string | null): string | null {
  if (!path) return null;
  return path.startsWith('http') ? path : `/assets/${path.replace(/^\/+/, '')}`;
}
