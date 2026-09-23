/**
 * Checkout provider contract — POST /v1/shop/checkout as called by the SR
 * path: server-cart token + live revision, the selected shippingMethodCode,
 * one Idempotency-Key per attempt (reused across retries of the SAME attempt,
 * rotated only on payload_mismatch), conflict adoption, and the merged-cart
 * double-submit guard. Vendure-side imports are stubbed; fetch is mocked.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/generated/graphql-shop', () => ({}));
vi.mock('~/generated/graphql-shop-typed', () => ({}));
vi.mock('~/utils/api', () => ({ requester: vi.fn() }));
vi.mock('~/services/CountryService', () => ({ CountryService: { getAvailableCountries: vi.fn(async () => []) } }));
vi.mock('~/services/ShippingService', () => ({ ShippingService: { getEligibleShippingMethods: vi.fn(async () => []) } }));
vi.mock('~/services/PaymentService', () => ({ PaymentService: { getPaymentMethods: vi.fn(async () => []) } }));

const snapshot = vi.fn();
const adoptConflictCart = vi.fn();
const discardLocal = vi.fn();
vi.mock('~/services/ServerCartService', () => ({
	ServerCartService: {
		checkoutSnapshot: (...a: unknown[]) => snapshot(...a),
		adoptConflictCart: (...a: unknown[]) => adoptConflictCart(...a),
		discardLocal: (...a: unknown[]) => discardLocal(...a),
	},
}));

import { placeOrder } from './checkout';

type FetchCall = { url: string; init: RequestInit };
const calls: FetchCall[] = [];
let queue: Promise<Response>[] = [];
const respond = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const enqueue = (...r: Promise<Response>[]) => queue.push(...r);

const form = {
	email: 'a@b.c',
	shippingAddress: { fullName: 'A B', line1: '1 St', city: 'X', postalCode: '1', countryCode: 'US' },
	shippingMethodCode: 'std',
	items: [{ sku: 'SKU1', quantity: 1 }],
};

beforeEach(() => {
	calls.length = 0;
	queue = [];
	snapshot.mockReset().mockResolvedValue({ token: 'tok_srv', revision: 5, status: 'active' });
	adoptConflictCart.mockReset();
	discardLocal.mockReset();
	vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = queue.shift();
		if (!next) throw new Error(`unstubbed fetch: ${url}`);
		return next;
	}));
});

afterEach(() => vi.unstubAllGlobals());

const lastBody = () => JSON.parse(String(calls[calls.length - 1].init.body ?? '{}'));

describe('placeOrder → POST /v1/shop/checkout', () => {
	it('sends cartToken + live revision + shippingMethodCode, server cart wins', async () => {
		enqueue(respond(200, { code: 'O1', state: 'PendingPayment', grandTotal: 5800, receiptToken: 'rt_1' }));
		const res = await placeOrder(form);
		expect(calls[0].url).toContain('/v1/shop/checkout');
		const body = lastBody();
		expect(body.cartToken).toBe('tok_srv');
		expect(body.expectedRevision).toBe(5);
		expect(body.shippingMethodCode).toBe('std');
		expect(body.email).toBe('a@b.c');
		expect(res.code).toBe('O1');
		expect(res.receiptToken).toBe('rt_1');
	});

	it('reuses one Idempotency-Key across retries of the same attempt', async () => {
		enqueue(
			respond(500, { error: 'blip' }),
			respond(200, { code: 'O2', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_2' }),
		);
		await placeOrder(form).catch(() => {});
		await placeOrder(form);
		const keys = calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']);
		expect(keys[0]).toBeTruthy();
		expect(keys[0]).toBe(keys[1]);
	});

	it('rotates the key only on payload_mismatch', async () => {
		enqueue(
			respond(409, { reason: 'payload_mismatch' }),
			respond(200, { code: 'O3', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt_3' }),
		);
		await placeOrder(form).catch(() => {});
		await placeOrder(form);
		const keys = calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']);
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).toBeTruthy();
		expect(keys[1]).not.toBe(keys[0]);
	});

	it('stale-cart conflict adopts the server snapshot and tells the shopper to review', async () => {
		const conflictCart = { token: 'tok_srv', revision: 9, status: 'active', currency: 'USD', subtotal: 0, discountTotal: 0, lines: [] };
		enqueue(respond(409, { error: 'cart changed', code: 'stale', revision: 9, cart: conflictCart }));
		await expect(placeOrder(form)).rejects.toThrow('cart changed');
		expect(adoptConflictCart).toHaveBeenCalledWith(conflictCart);
	});

	it('merged cart refuses to place — no double submit of moved lines', async () => {
		snapshot.mockResolvedValueOnce({ token: 'tok_srv', revision: 5, status: 'merged' });
		await expect(placeOrder(form)).rejects.toThrow('merged');
		expect(discardLocal).toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});
});
