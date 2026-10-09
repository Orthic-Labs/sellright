/**
 * Thin admin/shop API client for e2e setup and verification (Node fetch, bearer auth — CSRF-exempt, no browser).
 * Specs drive the storefront UI; this is only for arranging state (catalog, promotions, gateways) and for reading
 * the *live* truth back (stock, order state, emails). Nothing here caches — stock-architecture lock: every stock
 * assertion re-reads the inventory endpoint at the moment it is made.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { API_DIR, API_URL, DB_OWNER_URL, OWNER_EMAIL, OWNER_PASSWORD, STORE_SLUG } from './env.mjs';

export class ApiFailure extends Error {
	constructor(public status: number, public body: unknown, what: string) {
		super(`${what} -> ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
	}
}

export class AdminApi {
	constructor(public token: string, public slug = STORE_SLUG, public baseUrl = API_URL) {}

	static async login(email = OWNER_EMAIL, password = OWNER_PASSWORD, baseUrl = API_URL): Promise<AdminApi> {
		const res = await fetch(`${baseUrl}/v1/admin/login`, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
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
		try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
		if (!res.ok) throw new ApiFailure(res.status, json, `${method} ${path}`);
		return json as T;
	}

	get = <T = any>(p: string) => this.call<T>('GET', p);
	post = <T = any>(p: string, b: unknown = {}) => this.call<T>('POST', p, b);
	patch = <T = any>(p: string, b: unknown = {}) => this.call<T>('PATCH', p, b);
	put = <T = any>(p: string, b: unknown = {}) => this.call<T>('PUT', p, b);
	del = <T = any>(p: string) => this.call<T>('DELETE', p);

	// ── live reads (never cached) ──────────────────────────────────────────────
	/** Live stock for a SKU, straight from the inventory endpoint. `available = onHand - allocated`. */
	async stock(sku: string): Promise<{ variantId: string; sku: string; onHand: number; allocated: number; available: number }> {
		const r = await this.get<{ items: Array<{ variantId: string; sku: string; onHand: number; allocated: number; available: number }> }>(`/inventory?q=${encodeURIComponent(sku)}&pageSize=100`);
		const row = r.items.find((i) => i.sku === sku);
		if (!row) throw new Error(`no inventory row for ${sku}`);
		return row;
	}
	order = (code: string) => this.get(`/orders/${encodeURIComponent(code)}`);
}

let n = 0;
/** Unique, readable token for emails/codes so specs never collide inside one shared database. */
export const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${(n++).toString(36)}`;

/** A distinct simulated client address per call. The API's per-IP checkout/payment limiter (8 per 15 min) stays ON;
 *  each simulated shopper just gets their own address via the proxy header the API trusts (TRUSTED_PROXY_HEADER). */
export const clientIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + (n++ % 250)}`;

export const US_ADDRESS = {
	fullName: 'Ada Buyer', line1: '1 Main St', city: 'Reno', province: 'NV', postalCode: '89501', country: 'US', phone: '+17755550100',
};

/** Seeded fixtures (see global-setup.ts). `shirt` has deep stock; `lastUnit` is re-armed to exactly one unit per spec. */
export const SKU = { shirt: 'E2E-SHIRT-1', mug: 'E2E-MUG-1', book: 'E2E-BOOK-1', inStock: 'E2E-INSTOCK-1', oos: 'E2E-OOS-1' } as const;
export const SHIPPING = { flat: 'e2e-flat', free: 'e2e-free' } as const;
export const PRODUCT = {
	shirt: { slug: 'e2e-shirt', price: 2500 }, mug: { slug: 'e2e-mug', price: 1200 }, book: { slug: 'e2e-book', price: 1800 },
	inStock: { slug: 'e2e-in-stock-tee', price: 2500 },
} as const;

/** Place an order through the real public checkout route (what the storefront calls). The order lands PendingPayment
 *  with stock reserved; the receipt token authorizes the follow-up payment calls. */
export async function shopCheckout(o: {
	email: string; items?: Array<{ sku: string; quantity: number }>; couponCode?: string; shippingMethodCode?: string;
}): Promise<{ code: string; state: string; grandTotal: number; discountTotal: number; shippingTotal: number; couponApplied: boolean; receiptToken: string }> {
	const res = await fetch(`${API_URL}/v1/shop/checkout`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-real-ip': clientIp() },
		body: JSON.stringify({
			items: o.items ?? [{ sku: SKU.shirt, quantity: 1 }],
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

/** Start a gateway payment attempt for an existing PendingPayment order (what the NMI / Sezzle components call). */
export async function shopGatewayPayment(code: string, receiptToken: string, body: { method: 'nmi' | 'sezzle'; token?: string }, idempotencyKey = crypto.randomUUID()) {
	const res = await fetch(`${API_URL}/v1/shop/orders/${encodeURIComponent(code)}/gateway-payment`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-receipt-token': receiptToken, 'x-real-ip': clientIp() },
		body: JSON.stringify(body),
	});
	const json = await res.json().catch(() => ({}));
	return { status: res.status, body: json as { attemptId?: string; status?: string; checkoutUrl?: string; state?: string; message?: string } };
}

// ── read-only verification queries ───────────────────────────────────────────────────────────────────────
const { Client } = createRequire(join(API_DIR, 'package.json'))('pg');

/**
 * Read-only verification queries against the throwaway e2e database, for facts no endpoint exposes
 * (email_outbox status, payment_attempt rows, ...). Runs in a READ ONLY transaction with the tenant GUC set, so it
 * behaves under FORCE RLS exactly like the API itself. Never used to arrange state or to assert stock.
 */
export async function readRows<T = Record<string, unknown>>(api: AdminApi, sqlText: string, params: unknown[] = []): Promise<T[]> {
	const me = await api.get<{ stores: { storeId: string; slug: string }[] }>('/me');
	const storeId = me.stores.find((s) => s.slug === api.slug)!.storeId;
	const c = new Client({ connectionString: DB_OWNER_URL });
	await c.connect();
	try {
		await c.query('BEGIN READ ONLY');
		await c.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
		const r = await c.query(sqlText, params);
		await c.query('ROLLBACK');
		return r.rows as T[];
	} finally {
		await c.end();
	}
}

/** One-off privileged write for setup the API has no endpoint for (never for stock): runs `fn` with the tenant GUC set. */
export async function writeSetup(api: AdminApi, sqlText: string, params: unknown[] = []): Promise<void> {
	const me = await api.get<{ stores: { storeId: string; slug: string }[] }>('/me');
	const storeId = me.stores.find((s) => s.slug === api.slug)!.storeId;
	const c = new Client({ connectionString: DB_OWNER_URL });
	await c.connect();
	try {
		await c.query('BEGIN');
		await c.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
		await c.query(sqlText, params);
		await c.query('COMMIT');
	} finally {
		await c.end();
	}
}

/** Poll until `fn` returns a truthy value (outboxes drain on the API's 1s e2e scheduler tick). */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** email_outbox rows for one recipient (the durable queue the API's worker drains over SMTP). */
export const emailRows = (api: AdminApi, recipient: string, kind?: string) =>
	readRows<{ kind: string; status: string; attempts: number; subject: string }>(
		api,
		`SELECT kind, status, attempts, payload->>'subject' AS subject FROM email_outbox WHERE recipient = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY created_at`,
		kind ? [recipient.toLowerCase(), kind] : [recipient.toLowerCase()],
	);

/** Wait until at least `count` outbox rows of `kind` for `recipient` exist and every one of them is `sent`. */
export async function sentEmails(api: AdminApi, recipient: string, kind: string, count = 1) {
	return eventually(async () => {
		const rows = await emailRows(api, recipient, kind);
		return rows.length >= count && rows.every((r) => r.status === 'sent') ? rows : null;
	}, `${count} sent '${kind}' email(s) for ${recipient}`);
}

/** Make sure a customer record exists for `email`, so a later checkout with that address is linked to it (email match). */
export async function ensureCustomer(api: AdminApi, email: string, firstName = 'Ada', lastName = 'Buyer'): Promise<void> {
	const res = await api.raw('POST', '/customers', { email, firstName, lastName });
	if (!res.ok && res.status !== 409) throw new ApiFailure(res.status, await res.text(), `create customer ${email}`);
}

/** Place a storefront order and pay it through the real NMI payment path (mock gateway approves `tok_visa`). */
export async function paidOrder(o: { email: string; items?: Array<{ sku: string; quantity: number }>; couponCode?: string }) {
	const placed = await shopCheckout(o);
	const paid = await shopGatewayPayment(placed.code, placed.receiptToken, { method: 'nmi', token: 'tok_visa' });
	if (paid.status !== 200 || paid.body.state !== 'Paid') throw new ApiFailure(paid.status, paid.body, `pay ${placed.code}`);
	return placed;
}
