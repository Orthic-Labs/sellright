/**
 * SellRight REST client (replaces the Vendure GraphQL requester for the dynamic
 * paths). SSR fetches the API directly (localhost:3300 on the box); the browser
 * uses relative /v1 paths which vite/the host proxies to the API (no CORS).
 */
import { isServer } from '@qwik.dev/core/build';

const API = 'http://127.0.0.1:3300';
const STORE_SLUG = 'damned';

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
