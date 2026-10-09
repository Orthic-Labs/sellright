/**
 * Thin admin-API client for test setup/verification (Node fetch, bearer auth — CSRF-exempt, no browser).
 * Specs drive the UI; this is only for arranging state (orders, customers) and for reading the *live*
 * truth back (stock, order status) — nothing here caches, per the stock-architecture lock.
 */
import { createHmac } from 'node:crypto';
import { API_URL, OWNER_EMAIL, OWNER_PASSWORD, STORE_SLUG } from './env.mjs';

export class ApiFailure extends Error {
  constructor(public status: number, public body: unknown, what: string) {
    super(`${what} -> ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

export class AdminApi {
  constructor(public token: string, public slug = STORE_SLUG, public baseUrl = API_URL) {}

  static async login(email = OWNER_EMAIL, password = OWNER_PASSWORD, totp?: string, baseUrl = API_URL): Promise<AdminApi> {
    const res = await fetch(`${baseUrl}/v1/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiFailure(res.status, body, `login ${email}`);
    return new AdminApi((body as { token: string }).token, undefined, baseUrl);
  }

  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}/v1/admin${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, 'x-store-slug': this.slug },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON (csv/html) */ }
    if (!res.ok) throw new ApiFailure(res.status, json, `${method} ${path}`);
    return json as T;
  }

  get = <T = any>(p: string) => this.call<T>('GET', p);
  post = <T = any>(p: string, b: unknown = {}) => this.call<T>('POST', p, b);
  patch = <T = any>(p: string, b: unknown = {}) => this.call<T>('PATCH', p, b);
  put = <T = any>(p: string, b: unknown = {}) => this.call<T>('PUT', p, b);
  del = <T = any>(p: string) => this.call<T>('DELETE', p);

  // ── live reads (never cached) ──────────────────────────────────────────────
  /** Live stock for a SKU straight from the inventory endpoint. */
  async stock(sku: string): Promise<{ variantId: string; sku: string; onHand: number; allocated: number; available: number }> {
    const r = await this.get<{ items: Array<{ variantId: string; sku: string; onHand: number; allocated: number; available: number }> }>(`/inventory?q=${encodeURIComponent(sku)}&pageSize=100`);
    const row = r.items.find((i) => i.sku === sku);
    if (!row) throw new Error(`no inventory row for ${sku}`);
    return row;
  }
  order = (code: string) => this.get(`/orders/${encodeURIComponent(code)}`);
}

let n = 0;
/** Unique, readable token for emails/codes so specs never collide inside one shared DB. */
export const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${(n++).toString(36)}`;

export const US_ADDRESS = {
  fullName: 'Ada Buyer', line1: '1 Main St', city: 'Reno', province: 'NV', postalCode: '89501', country: 'US', phone: '+17755550100',
};

export interface PaidOrderOpts {
  email?: string;
  items?: Array<{ sku: string; quantity: number }>;
  markPaid?: boolean;
  shippingMethodCode?: string;
  shippingAddress?: Record<string, unknown>;
}

/** Create a manual order through the real admin draft-order route (reserves stock like checkout). */
export async function createOrder(api: AdminApi, o: PaidOrderOpts = {}): Promise<{ code: string; state: string; grandTotal: number }> {
  // The draft-order route links an order to a customer only when that customer already exists.
  if (o.email) await ensureCustomer(api, o.email);
  return api.post('/draft-orders', {
    items: o.items ?? [{ sku: SKU.tee, quantity: 1 }],
    email: o.email,
    markPaid: o.markPaid ?? true,
    shippingMethodCode: o.shippingMethodCode ?? 'e2e-flat',
    shippingAddress: o.shippingAddress ?? US_ADDRESS,
  });
}
export const createPendingOrder = (api: AdminApi, o: PaidOrderOpts = {}) => createOrder(api, { ...o, markPaid: false });

export async function ensureCustomer(api: AdminApi, email: string, firstName = 'Ada', lastName = 'Buyer'): Promise<void> {
  const res = await api.raw('POST', '/customers', { email, firstName, lastName });
  if (!res.ok && res.status !== 409) throw new ApiFailure(res.status, await res.text(), `create customer ${email}`);
}

export async function createCustomer(api: AdminApi, email: string, firstName = 'Ada', lastName = 'Buyer'): Promise<string> {
  const r = await api.post<{ id: string }>('/customers', { email, firstName, lastName });
  return r.id;
}

/** Seeded SKUs (see seed.ts). `tee`/`mug` have deep stock; `low` is at the low-stock threshold. */
export const SKU = { tee: 'E2E-TEE-1', mug: 'E2E-MUG-1', low: 'E2E-LOW-1', oos: 'E2E-OOS-1' } as const;
export const SHIPPING = { flat: 'e2e-flat', free: 'e2e-free' } as const;

// ── RFC 6238 TOTP (SHA1, 30s, 6 digits) so the suite can drive 2FA logins without an authenticator ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.toUpperCase().replace(/=+$/, '')) { const v = B32.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export const totpStep = (now = Date.now()) => Math.floor(now / 30000);
export function totpAt(secret: string, step: number): string {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = ((h[o]! & 0x7f) << 24) | ((h[o + 1]! & 0xff) << 16) | ((h[o + 2]! & 0xff) << 8) | (h[o + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Place a storefront order through the real public checkout route (what the storefront calls). Used to prove
 * server-side enforcement (usage limits, automatic discounts) end to end. The order lands PendingPayment with
 * stock reserved — no payment gateway is involved. The Host header is 127.0.0.1 so the store resolves by hostname.
 */
export async function shopCheckout(o: {
  email: string; items?: Array<{ sku: string; quantity: number }>; couponCode?: string; shippingMethodCode?: string;
}): Promise<{ code: string; state: string; grandTotal: number; discountTotal: number; couponApplied: boolean }> {
  const res = await fetch(`${API_URL}/v1/shop/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(),
      // The public checkout route allows 8 attempts per client IP per 15 minutes. A suite places far more orders
      // than one shopper would, so each simulated shopper gets its own address via the proxy header the API trusts
      // (TRUSTED_PROXY_HEADER, default x-real-ip) — the limiter itself stays on.
      'x-real-ip': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + (n++ % 250)}`,
    },
    body: JSON.stringify({
      items: o.items ?? [{ sku: SKU.tee, quantity: 1 }],
      couponCode: o.couponCode,
      shippingMethodCode: o.shippingMethodCode ?? SHIPPING.flat,
      email: o.email,
      shippingAddress: US_ADDRESS,
      billingAddress: US_ADDRESS,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new ApiFailure(res.status, body, 'shop checkout');
  return body as never;
}
