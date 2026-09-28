/**
 * Consumer-contract tests for `~/sellright/content` — the typed content/misc
 * wrappers over the generated OpenAPI client. Every call is asserted against
 * a mocked global `fetch`: no network, no credentials, no store row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAffiliateStats, newsletterSignup, trackOrder, unsubscribeSubscriber } from './content';

type FetchCall = { url: string; init: RequestInit };
const calls: FetchCall[] = [];

const jsonResponse = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

let queue: Promise<Response>[] = [];
const enqueue = (...responses: Promise<Response>[]) => queue.push(...responses);

beforeEach(() => {
	calls.length = 0;
	queue = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: unknown, init?: RequestInit) => {
			// openapi-fetch calls `fetch(new Request(url, requestInit), ...)` — the
			// body/headers/method live on the Request object itself, not on a
			// second `init` argument, so both have to be read off `input`.
			const req = input as Request;
			const url = typeof input === 'string' ? input : req.url;
			const body = typeof input === 'string' ? (init?.body as string | undefined) : await req.clone().text();
			calls.push({ url, init: { ...(init ?? {}), body } });
			const next = queue.shift();
			if (!next) throw new Error('fetch called with no queued response');
			return next;
		}),
	);
});

afterEach(() => vi.unstubAllGlobals());

const lastCall = () => calls[calls.length - 1];

describe('trackOrder', () => {
	it('normalizes the raw API response into a TrackedOrder with a derived displayStatus', async () => {
		enqueue(
			jsonResponse(200, {
				code: 'SR1', state: 'Paid', placedAt: '2026-01-01T00:00:00.000Z', currency: 'USD',
				subtotal: 1000, shippingTotal: 500, taxTotal: 0, discountTotal: 0, grandTotal: 1500,
				shippingAddress: { fullName: 'Ada Lovelace', line1: '1 Analytical Engine Way', line2: null, city: 'London', province: '', postalCode: 'SW1A 1AA', country: 'GB', phone: null },
				fulfillments: [{ state: 'Shipped', trackingCode: 'TRACK123', carrier: 'USPS', updatedAt: '2026-01-02T00:00:00.000Z' }],
				payments: [{ method: 'card', state: 'Settled', amount: 1500, providerRef: 'pi_1', errorMessage: null, createdAt: '2026-01-01T00:00:00.000Z' }],
				lines: [{ sku: 'SKU-1', name: 'Widget', quantity: 1, unitPrice: 1000, lineTotal: 1000, isPreOrder: false, shipDate: null }],
			}),
		);

		const result = await trackOrder('SR1', 'ada@example.com');

		expect(result.success).toBe(true);
		if (!result.success) throw new Error('expected success');
		expect(result.order.code).toBe('SR1');
		expect(result.order.state).toBe('Paid');
		expect(result.order.displayStatus).toBe('Shipped');
		expect(result.order.shippingAddress?.line1).toBe('1 Analytical Engine Way');
		expect(result.order.payments).toHaveLength(1);
		expect(String(lastCall().url)).toContain('/v1/shop/track');
		expect(String(lastCall().url)).toContain('code=SR1');
	});

	it('derives PartiallyShipped when some but not all fulfillments have shipped', async () => {
		enqueue(
			jsonResponse(200, {
				code: 'SR2', state: 'Paid', placedAt: null, currency: 'USD',
				subtotal: 0, shippingTotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 0,
				shippingAddress: null,
				fulfillments: [
					{ state: 'Shipped', trackingCode: 'A', carrier: 'USPS', updatedAt: null },
					{ state: 'Pending', trackingCode: null, carrier: null, updatedAt: null },
				],
				payments: [],
				lines: [],
			}),
		);
		const result = await trackOrder('SR2', 'x@y.z');
		expect(result.success && result.order.displayStatus).toBe('PartiallyShipped');
	});

	it('derives AwaitingPayment for PendingPayment orders regardless of fulfillments', async () => {
		enqueue(
			jsonResponse(200, {
				code: 'SR3', state: 'PendingPayment', placedAt: null, currency: 'USD',
				subtotal: 0, shippingTotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 0,
				shippingAddress: null, fulfillments: [], payments: [], lines: [],
			}),
		);
		const result = await trackOrder('SR3', 'x@y.z');
		expect(result.success && result.order.displayStatus).toBe('AwaitingPayment');
	});

	it('returns a not-found error on 404', async () => {
		enqueue(jsonResponse(404, { error: 'order not found for that code + email' }));
		const result = await trackOrder('MISSING', 'x@y.z');
		expect(result).toEqual({ success: false, error: 'Order not found for that code + email.' });
	});
});

describe('newsletterSignup', () => {
	it('posts the email to the API', async () => {
		enqueue(jsonResponse(200, { ok: true }));
		const result = await newsletterSignup('subscriber@example.com');
		expect(result).toEqual({ ok: true });
		expect(String(lastCall().url)).toContain('/v1/shop/newsletter-signup');
		expect(JSON.parse(String(lastCall().init.body))).toEqual({ email: 'subscriber@example.com', source: 'storefront' });
	});

	it('never calls the API when the honeypot is filled', async () => {
		const result = await newsletterSignup('bot@example.com', 'i-am-a-bot');
		expect(result).toEqual({ ok: true });
		expect(calls).toHaveLength(0);
	});

	it('surfaces the rate-limit message on 429', async () => {
		enqueue(jsonResponse(429, { error: 'too many attempts' }));
		const result = await newsletterSignup('subscriber@example.com');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('Too many signups');
	});
});

describe('unsubscribeSubscriber', () => {
	it('posts to the token-scoped unsubscribe route', async () => {
		enqueue(Promise.resolve(new Response(null, { status: 204 })));
		const result = await unsubscribeSubscriber('tok_123');
		expect(result).toEqual({ ok: true });
		expect(String(lastCall().url)).toContain('/v1/shop/subscriber/unsubscribe/tok_123');
	});
});

describe('fetchAffiliateStats', () => {
	it('rejects an obviously invalid token without calling the API', async () => {
		const result = await fetchAffiliateStats('short');
		expect(result).toEqual({ success: false, error: 'Invalid or expired link.' });
		expect(calls).toHaveLength(0);
	});

	it('resolves stats for a valid token', async () => {
		enqueue(jsonResponse(200, { email: 'aff@example.com', couponCode: 'AFF10', rate: 0.1 }));
		const token = 'a'.repeat(32);
		const result = await fetchAffiliateStats(token);
		expect(result.success).toBe(true);
		expect(result.couponCode).toBe('AFF10');
		expect(String(lastCall().url)).toContain(`t=${token}`);
	});

	it('reports an invalid link on 404', async () => {
		enqueue(jsonResponse(404, { error: 'not found' }));
		const token = 'b'.repeat(32);
		const result = await fetchAffiliateStats(token);
		expect(result).toEqual({ success: false, error: 'Invalid affiliate link.' });
	});
});
