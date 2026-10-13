// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter, forwardToGa4, parseSinkEvent } from './analytics-sink';
import { conversionPayload, trackPurchaseOnce } from './controllers/conversion';

const ev = (over: Record<string, unknown> = {}) => ({ name: 'add_to_cart', eventId: 'add_to_cart_1', currency: 'USD', value: 75, items: [{ item_id: 'RH-M', quantity: 1, price: 75 }], pageLocation: 'https://shop.test/shop/x/?q=1', gtagSent: false, clientId: '123.456', ...over });

describe('event sink', () => {
	it('accepts the three browser events, refuses purchase and anything malformed', () => {
		const e = parseSinkEvent(ev(), 'shop.test');
		expect(e).toMatchObject({ name: 'add_to_cart', pageLocation: 'https://shop.test/shop/x/', clientId: '123.456', gtagSent: false });
		expect(parseSinkEvent(ev({ name: 'purchase' }), 'shop.test')).toBe('purchase');
		expect(parseSinkEvent(ev({ name: 'refund' }), 'shop.test')).toBeNull();
		expect(parseSinkEvent(ev({ eventId: 'bad id' }), 'shop.test')).toBeNull();
		expect(parseSinkEvent(ev({ items: Array.from({ length: 21 }, () => ({ item_id: 'a', quantity: 1 })) }), 'shop.test')).toBeNull();
		expect(parseSinkEvent(ev({ items: [{ item_id: 'a', quantity: 0 }] }), 'shop.test')).toBeNull();
		expect(parseSinkEvent(ev(), 'other.test')?.valueOf()).toMatchObject({ pageLocation: undefined });
	});

	it('rate-limits per IP per minute window', () => {
		let t = 0;
		const limited = createRateLimiter(2, () => t);
		expect([limited('a'), limited('a'), limited('a'), limited('b')]).toEqual([false, false, true, false]);
		t = 60_000;
		expect(limited('a')).toBe(false);
	});

	it('forwards to GA4 only when the browser tag did not send it and GA4 is configured; never throws', async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
		const e = parseSinkEvent(ev(), 'shop.test') as Exclude<ReturnType<typeof parseSinkEvent>, null | 'purchase'>;
		expect(await forwardToGa4({ ...e, gtagSent: true }, { id: 'G-1', secret: 's' }, fetcher as never)).toBe(false);
		expect(await forwardToGa4(e, { id: undefined, secret: 's' }, fetcher as never)).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
		expect(await forwardToGa4(e, { id: 'G-1', secret: 's' }, fetcher as never)).toBe(true);
		expect(String((fetcher.mock.calls[0] as unknown[])[0])).toContain('measurement_id=G-1');
		expect(await forwardToGa4(e, { id: 'G-1', secret: 's' }, (async () => { throw new Error('down'); }) as never)).toBe(false);
	});
});

describe('conversion payload', () => {
	it('minor units in, major units out; purchase goes to the dataLayer only (no beacon) with transaction_id', () => {
		const add = conversionPayload({ name: 'add_to_cart', sku: 'S', productName: 'Shirt', price: 7500, currency: 'USD', quantity: 2 }, 'id1', 'https://x/', undefined, false);
		expect(add.dataLayer.ecommerce).toMatchObject({ value: 150, items: [{ item_id: 'S', price: 75, quantity: 2 }] });
		expect(add.beacon?.event).toMatchObject({ name: 'add_to_cart', eventId: 'id1', gtagSent: false });
		const p = conversionPayload({ name: 'purchase', orderCode: 'RH1', currency: 'USD', value: 8000, itemCount: 1 }, 'purchase_RH1', 'https://x/', undefined, true);
		expect(p.beacon).toBeNull();
		expect(p.dataLayer).toMatchObject({ event: 'purchase', event_id: 'purchase_RH1', ecommerce: { transaction_id: 'RH1', value: 80 } });
	});
});

describe('purchase dedup (review round 1)', () => {
	it('marks nothing while the subscriber is not running or consent is absent, so a later load can still send it', () => {
		const setItem = vi.fn();
		vi.stubGlobal('window', {});
		vi.stubGlobal('sessionStorage', { getItem: () => null, setItem });
		trackPurchaseOnce({ code: 'RH1', currency: 'USD', grandTotal: 100, lines: [] });
		expect(setItem).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
