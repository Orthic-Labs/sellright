// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { FormPort, FormStatus } from './forms';
import { hasAuthoritativeRestockStock, PRODUCT_UUID, submitRestock } from './restock-form';

const productId = '12345678-1234-4123-8123-123456789abc';
const state = (token = 'fresh-token', required = true) => {
	const value = { status: 'idle' as FormStatus, message: '', token, resets: 0 };
	const port: FormPort = {
		getStatus: () => value.status,
		setStatus: (status) => { value.status = status; },
		setMessage: (message) => { value.message = message; },
		getToken: () => value.token,
		clearToken: () => { value.token = ''; },
		resetWidget: () => { value.resets++; },
		turnstileRequired: required,
	};
	return { value, port };
};

describe('restock form submission', () => {
	it('blocks invalid identity/email & missing required token before any request', async () => {
		for (const [id, email, token] of [['slug-not-uuid', 'a@b.co', 'token'], [productId, 'invalid', 'token'], [productId, 'a@b.co', '']]) {
			const s = state(token);
			const request = vi.fn();
			expect((await submitRestock(s.port, request, id, email, '')).ok).toBe(false);
			expect(request).not.toHaveBeenCalled();
			expect(s.value.resets).toBe(0);
		}
	});

	it('posts one product-level request, consumes token immediately, & refuses duplicate clicks while pending', async () => {
		const s = state();
		let release!: (value: { success: boolean }) => void;
		const request = vi.fn(() => new Promise<{ success: boolean }>((resolve) => { release = resolve; }));
		const first = submitRestock(s.port, request, productId, ' a@b.co ', 'bot');
		expect(request).toHaveBeenCalledExactlyOnceWith({ productId, email: 'a@b.co', turnstileToken: 'fresh-token', honeypot: 'bot' });
		expect(s.value.token).toBe('');
		expect(s.value.resets).toBe(1);
		expect(await submitRestock(s.port, request, productId, 'a@b.co', '')).toEqual({ ok: false, reason: 'busy' });
		expect(request).toHaveBeenCalledTimes(1);
		release({ success: true });
		expect(await first).toEqual({ ok: true });
		expect(s.value.status).toBe('success');
	});

	it('a failed request requires a freshly solved token before retry; stale token never replays', async () => {
		const s = state('first-token');
		const request = vi.fn().mockResolvedValueOnce({ success: false, message: 'Try again.' }).mockResolvedValueOnce({ success: true });
		expect(await submitRestock(s.port, request, productId, 'a@b.co', '')).toEqual({ ok: false, reason: 'server' });
		expect(s.value.message).toBe('Try again.');
		expect(await submitRestock(s.port, request, productId, 'a@b.co', '')).toEqual({ ok: false, reason: 'turnstile' });
		expect(request).toHaveBeenCalledTimes(1);
		s.value.token = 'second-token';
		expect(await submitRestock(s.port, request, productId, 'a@b.co', '')).toEqual({ ok: true });
		expect(request.mock.calls.map(([body]) => body.turnstileToken)).toEqual(['first-token', 'second-token']);
	});

	it('supports stores without a configured site key while keeping server failure visible', async () => {
		const s = state('', false);
		const request = vi.fn().mockRejectedValue(new Error('offline'));
		expect(await submitRestock(s.port, request, productId, 'a@b.co', '')).toEqual({ ok: false, reason: 'server' });
		expect(request).toHaveBeenCalledExactlyOnceWith({ productId, email: 'a@b.co', turnstileToken: '', honeypot: '' });
		expect(s.value.status).toBe('error');
	});
});

describe('waitlist authoritative stock admission', () => {
	const variants = [{ sku: 'white', enabled: true }, { sku: 'black', enabled: true }, { sku: 'retired', enabled: false }];
	const out = (sku: string) => ({ sku, inStock: false, availableQuantity: 0 });
	it('requires positive recognized enabled-SKU evidence with complete coverage', () => {
		expect(hasAuthoritativeRestockStock(variants, { variants: [out('white'), out('black')] })).toBe(true);
		for (const stock of [null, {}, { variants: [] }, { variants: [out('white')] }, { variants: [out('white'), out('unknown')] }, { variants: [out('white'), out('white')] }, { variants: [out('white'), out('black'), { sku: 'new', inStock: true, availableQuantity: 1 }] }]) {
			expect(hasAuthoritativeRestockStock(variants, stock)).toBe(false);
		}
		expect(hasAuthoritativeRestockStock([{ sku: 'retired', enabled: false }], { variants: [out('retired')] })).toBe(false);
	});
	it('rejects malformed or contradictory rows instead of interpreting them as sold out', () => {
		for (const row of [null, {}, { sku: 'white', inStock: 'false', availableQuantity: 0 }, { sku: 'white', availableQuantity: 0 }, { sku: 'white', inStock: false }, { sku: 'white', inStock: false, availableQuantity: -1 }, { sku: 'white', inStock: false, availableQuantity: 0.5 }, { sku: 'white', inStock: false, availableQuantity: 1 }, { sku: 'white', inStock: false, availableQuantity: null }]) {
			expect(hasAuthoritativeRestockStock(variants, { variants: [row, out('black')] })).toBe(false);
		}
	});
	it('recognizes valid stocked/uncapped coverage without changing its separate sold-out decision', () => {
		for (const availableQuantity of [4, null]) {
			expect(hasAuthoritativeRestockStock(variants, { variants: [{ sku: 'white', inStock: true, availableQuantity }, out('black')] })).toBe(true);
		}
	});
	it('uses a UUID predicate for displayed & submitted product identity', () => {
		expect(PRODUCT_UUID.test(productId)).toBe(true);
		for (const id of ['', 'anzu', 'not-a-uuid']) expect(PRODUCT_UUID.test(id)).toBe(false);
	});
});
