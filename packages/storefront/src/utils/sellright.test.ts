/**
 * Consumer-contract tests for the SellRight REST client — the exact wire
 * shapes the storefront depends on. Every call is asserted against a mocked
 * fetch: no network, no credentials, no store row required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	srShopConfig,
	srShippingMethods,
	srCreateCart,
	srGetCart,
	srAddCartLines,
	srSetCartLines,
	srCaptureCartEmail,
	srMergeCart,
	srCartConflict,
	srGatewayPayment,
	srVerifyGatewayPayment,
	srTrackOrder,
	srContact,
	srErrorStatus,
	srCheckEmail,
	srSearch,
	type SrCart,
} from './sellright';
import { adaptProduct, adaptSearch } from './sellright-adapters';
import { getBlogPosts, getBlogPostBySlug } from '../providers/shop/blog/blog';
import { loginMutation } from '../providers/shop/account/account';
import { registerCustomerFromSignup } from '../components/auth/signup-flow';

type FetchCall = { url: string; init: RequestInit };
const calls: FetchCall[] = [];

const respond = (status: number, body: unknown) => {
	const text = JSON.stringify(body);
	return Promise.resolve(
		new Response(text, {
			status,
			headers: { 'content-type': 'application/json' },
		}),
	);
};

let queue: Promise<Response>[] = [];
const enqueue = (...responses: Promise<Response>[]) => {
	queue.push(...responses);
};

beforeEach(() => {
	calls.length = 0;
	queue = [];
	vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = queue.shift();
		if (!next) throw new Error('fetch called with no queued response');
		return next;
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const lastCall = () => calls[calls.length - 1];
/** vitest runs with isServer=true → sr() prefixes the API origin; compare paths. */
const callPath = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
const lastPath = () => callPath(lastCall().url);
const lastBody = () => JSON.parse(String(lastCall().init.body ?? '{}'));

describe('migrated plugin contracts', () => {
	it('paginates legacy large browse requests within the API limit', async () => {
		const item = { slug: 'item', name: 'Item', status: 'active', inStock: false, minPrice: 100, image: null };
		enqueue(respond(200, { items: Array.from({ length: 100 }, () => item), total: 101 }), respond(200, { items: [item], total: 101 }));
		expect((await srSearch({ take: 200 })).items).toHaveLength(101);
		expect(callPath(calls[0].url)).toBe('/v1/shop/catalog/products?limit=100&offset=0');
		expect(lastPath()).toBe('/v1/shop/catalog/products?limit=100&offset=100');
		expect(adaptSearch({ total: 1, items: [item] }).items[0].inStock).toBe(false);
	});
	it('retains stable option and group identities for REST product selectors', () => {
		const option = { id: 'option-id', code: 'option-id', name: 'Red', group: { id: 'group-id', code: 'group-id', name: 'Color' } };
		const result = adaptProduct({ slug: 'fixture', name: 'Fixture', status: 'active', description: null, seoTitle: null, seoDescription: null, currency: 'USD', images: [], variants: [{ sku: 'RED', name: 'Red', price: 100, salePrice: null, preOrderPrice: null, shipDate: null, compareAtPrice: null, isPreOrder: false, enabled: true, options: [option] }] });
		expect(result.variants[0].options).toEqual([{ ...option, groupId: 'group-id' }]);
	});
	it('passes distinct fresh challenges through login and signup providers', async () => {
		enqueue(respond(200, { token: 'session', customer: { id: 'buyer', email: 'buyer@example.test' } }));
		await loginMutation('buyer@example.test', 'password1', true, 'fresh-login-token');
		expect(lastBody().turnstileToken).toBe('fresh-login-token');
		enqueue(respond(200, { token: 'session', customer: { id: 'buyer' } }));
		const result = await registerCustomerFromSignup({ email: 'buyer@example.test', password: 'password1', confirmPassword: 'password1', firstName: 'Test', lastName: 'Buyer', turnstileToken: 'fresh-signup-token' });
		expect(result).toEqual({ step: 'success' });
		expect(lastBody().turnstileToken).toBe('fresh-signup-token');
	});
	it('keeps listing price and preorder badges attached to the same variant', () => {
		const result = adaptSearch({ total: 1, items: [{ slug: 'widget', name: 'Widget', status: 'active', image: null, minPrice: 3000, pricingVariant: { sku: 'WIDGET', price: 5000, salePrice: 2000, preOrderPrice: 3000, isPreOrder: true, shipDate: '2027-01-01' } }] });
		expect(result.items[0]).toMatchObject({ productVariantId: 'WIDGET', priceWithTax: { min: 5000, max: 5000 } });
		expect(result.itemCustomFields[0]).toMatchObject({ productVariantId: 'WIDGET', preOrderPrice: 3000, isPreOrder: true });
	});
	it('passes bot challenge and honeypot through the email probe', async () => {
		enqueue(respond(200, { exists: false }));
		await srCheckEmail('a+b@example.test', 'challenge+&token', '');
		const query = new URL(lastCall().url, 'https://fixture.test').searchParams;
		expect(query.get('email')).toBe('a+b@example.test');
		expect(query.get('turnstileToken')).toBe('challenge+&token');
		expect(query.get('honeypot')).toBe('');
	});

	it('loads paged blogs and featured images from SellRight, not Vendure', async () => {
		const post = { id: 'post', slug: 'story', title: 'Story', excerpt: null, readingTime: 2, authorName: null, featuredAsset: { id: 'asset', path: '/assets/story.jpg' }, tags: null, publishDate: '2026-01-01T00:00:00.000Z' };
		enqueue(respond(200, { items: [post], totalItems: 30 }));
		const result = await getBlogPosts(10, 20);
		expect(lastPath()).toBe('/v1/shop/blog?take=10&skip=20');
		expect(result.totalItems).toBe(30);
		expect(result.items[0]).toMatchObject({ id: 'post', featuredAsset: { id: 'asset', preview: '/assets/story.jpg' }, createdAt: null });
		enqueue(respond(200, { ...post, bodyHtml: '<p>Story</p>', seoTitle: null, seoDescription: null }));
		expect(await getBlogPostBySlug('story')).toMatchObject({ bodyHtml: '<p>Story</p>', isPublished: true });
		expect(lastPath()).toBe('/v1/shop/blog/story');
		enqueue(respond(404, { error: 'post not found' }));
		expect(await getBlogPostBySlug('scheduled')).toBeNull();
		enqueue(respond(503, { error: 'unavailable' }));
		await expect(getBlogPostBySlug('story')).rejects.toThrow();
	});

	it.each([3000, null])('preserves preorder metadata with preorder price %s', preOrderPrice => {
		const product = adaptProduct({ slug: 'widget', name: 'Widget', description: null, status: 'active', seoTitle: null, seoDescription: null, currency: 'USD', images: [], variants: [{ sku: 'WIDGET', name: 'Widget', price: 5000, salePrice: 2000, preOrderPrice, shipDate: '2027-01-01T00:00:00.000Z', compareAtPrice: null, isPreOrder: true, enabled: true }] });
		expect(product.variants[0].priceWithTax).toBe(preOrderPrice ?? 5000);
		expect(product.variants[0].customFields).toMatchObject({ preOrderPrice, shipDate: '2027-01-01T00:00:00.000Z', isPreOrder: true });
	});
});

describe('cart contract — append vs set', () => {
	const cart: SrCart = {
		token: 'tok_1',
		revision: 3,
		status: 'active',
		currency: 'USD',
		subtotal: 5000,
		discountTotal: 0,
		lines: [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, available: true }],
	} as SrCart;

	it('create cart posts lines to /v1/shop/cart', async () => {
		enqueue(respond(200, cart));
		await srCreateCart({ items: [{ sku: 'SKU1', quantity: 1 }] });
		expect(lastPath()).toMatch(/\/v1\/shop\/cart$/);
		expect(lastCall().init.method).toBe('POST');
		expect(lastBody()).toEqual({ items: [{ sku: 'SKU1', quantity: 1 }] });
	});

	it('add lines is a blind append — no expectedRevision in the body', async () => {
		enqueue(respond(200, cart));
		await srAddCartLines('tok_1', [{ sku: 'SKU1', quantity: 2 }]);
		expect(lastPath()).toBe('/v1/shop/cart/tok_1/lines');
		expect(lastCall().init.method).toBe('PATCH');
		expect(lastBody()).toEqual({ lines: [{ sku: 'SKU1', quantity: 2 }] });
		expect(lastBody().expectedRevision).toBeUndefined();
	});

	it('set lines carries expectedRevision and absolute quantities', async () => {
		enqueue(respond(200, cart));
		await srSetCartLines('tok_1', [{ sku: 'SKU1', quantity: 0 }], 7);
		expect(lastBody()).toEqual({ lines: [{ sku: 'SKU1', quantity: 0 }], expectedRevision: 7 });
	});

	it('email capture is revisioned', async () => {
		enqueue(respond(200, cart));
		await srCaptureCartEmail('tok_1', 'a@b.c', 4);
		expect(lastCall().init.method).toBe('PATCH');
		expect(lastBody()).toEqual({ email: 'a@b.c', expectedRevision: 4 });
	});

	it('merge is revisioned via query param', async () => {
		enqueue(respond(200, cart));
		await srMergeCart('tok_1', 9);
		expect(lastPath()).toBe('/v1/shop/cart/tok_1/merge?expectedRevision=9');
		expect(lastCall().init.method).toBe('POST');
	});

	it('409 stale surfaces revision + cart snapshot via srCartConflict', async () => {
		const conflict = {
			error: 'cart changed',
			code: 'stale',
			revision: 5,
			cart,
		};
		enqueue(respond(409, conflict));
		const err = await srSetCartLines('tok_1', [{ sku: 'SKU1', quantity: 1 }], 3).then(
			() => { throw new Error('should have thrown'); },
			(e) => e,
		);
		expect(srErrorStatus(err)).toBe(409);
		const c = srCartConflict(err);
		expect(c?.code).toBe('stale');
		expect(c?.revision).toBe(5);
		expect(c?.cart.token).toBe('tok_1');
	});

	it('non-409 errors are not cart conflicts', async () => {
		enqueue(respond(500, { error: 'boom' }));
		const err = await srGetCart('tok_1').then(
			() => { throw new Error('should have thrown'); },
			(e) => e,
		);
		expect(srCartConflict(err)).toBeNull();
		expect(srErrorStatus(err)).toBe(500);
	});
});

describe('shop config + shipping', () => {
	it('shop config advertises gateway availability', async () => {
		enqueue(respond(200, {
			stripeMode: 'test',
			stripePublishableKey: null,
			stripeConfigured: false,
			gateways: { nmi: { tokenizationKey: 'pub_tok', mode: 'test', environment: 'production' }, sezzle: true },
		}));
		const cfg = await srShopConfig();
		expect(lastPath()).toBe('/v1/shop/config');
		expect(cfg.gateways.nmi?.tokenizationKey).toBe('pub_tok');
		expect(cfg.gateways.nmi?.mode).toBe('test');
		expect(cfg.gateways.nmi?.environment).toBe('production');
		expect(cfg.gateways.sezzle).toBe(true);
	});

	it('shipping methods query carries country + subtotal', async () => {
		enqueue(respond(200, { methods: [{ code: 'std', name: 'Standard', rate: 799 }] }));
		const res = await srShippingMethods('US', 5000);
		expect(lastPath()).toBe('/v1/shop/shipping-methods?country=US&subtotal=5000');
		expect(res.methods[0].code).toBe('std');
	});
});

describe('gateway payment contract', () => {
	it('NMI charge posts a payment_token with an idempotency key', async () => {
		enqueue(respond(200, { attemptId: 'att_1', status: 'settled', state: 'Paid' }));
		const res = await srGatewayPayment(
			'ORDER1',
			{ method: 'nmi', token: 'tok_abc' },
			{ idempotencyKey: 'idem-1', receiptToken: 'rt_1' },
		);
		expect(lastPath()).toBe('/v1/shop/orders/ORDER1/gateway-payment');
		expect(lastCall().init.method).toBe('POST');
		expect(lastBody()).toEqual({ method: 'nmi', token: 'tok_abc' });
		const headers = lastCall().init.headers as Record<string, string>;
		expect(headers['idempotency-key']).toBe('idem-1');
		expect(headers['x-receipt-token']).toBe('rt_1');
		expect(res.status).toBe('settled');
	});

	it('Sezzle session posts no token and returns a hosted checkoutUrl', async () => {
		enqueue(respond(200, {
			attemptId: 'att_2',
			status: 'pending',
			checkoutUrl: 'https://sandbox.checkout.sezzle.com/session/xyz',
		}));
		const res = await srGatewayPayment(
			'ORDER2',
			{ method: 'sezzle' },
			{ idempotencyKey: 'idem-2' },
		);
		expect(lastBody()).toEqual({ method: 'sezzle' });
		expect(lastBody().token).toBeUndefined();
		expect(res.checkoutUrl).toContain('sandbox.checkout.sezzle.com');
	});

	it('verify posts to the attempt-scoped route with the receipt token', async () => {
		enqueue(respond(200, { attemptId: 'att_2', status: 'settled', state: 'Paid' }));
		await srVerifyGatewayPayment('ORDER2', 'att_2', { receiptToken: 'rt_9' });
		expect(lastPath()).toBe('/v1/shop/orders/ORDER2/gateway-payment/att_2/verify');
		expect(lastCall().init.method).toBe('POST');
		const headers = lastCall().init.headers as Record<string, string>;
		expect(headers['x-receipt-token']).toBe('rt_9');
	});
});

describe('guest tracking + contact', () => {
	it('track passes code + email as query params', async () => {
		enqueue(respond(200, {
			code: 'T1', state: 'Shipped', placedAt: '2026-01-01', currency: 'USD',
			subtotal: 100, shippingTotal: 10, taxTotal: 0, discountTotal: 0, grandTotal: 110,
			shippingAddress: null, fulfillments: [], lines: [],
		}));
		const res = await srTrackOrder('T1', 'who@x.y');
		expect(lastPath()).toBe('/v1/shop/track?code=T1&email=who%40x.y');
		expect(res.state).toBe('Shipped');
	});

	it('contact posts the form fields', async () => {
		enqueue(respond(200, { ok: true }));
		await srContact({ name: 'A', email: 'a@b.c', subject: 'Hi', message: 'Msg', honeypot: '' });
		expect(lastPath()).toBe('/v1/shop/contact');
		expect(lastBody().message).toBe('Msg');
	});
});
