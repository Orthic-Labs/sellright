import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./analytics');
const viewItem = { name: 'view_item', sku: 'S1', productName: 'P', price: 1000, currency: 'USD' } as const;

describe('#425: events tracked before the subscriber starts', () => {
	let m: Mod;
	beforeEach(async () => {
		vi.resetModules();
		vi.stubGlobal('window', { localStorage: { removeItem: () => undefined } });
		m = await import('./analytics');
	});
	afterEach(() => vi.unstubAllGlobals());

	it('implied consent: a view_item tracked before subscription is delivered once when the subscriber starts', () => {
		m.track(viewItem);
		m.setAnalyticsConsent(true);
		const got: unknown[] = [];
		m.onAnalyticsEvent((e) => got.push(e));
		expect(got).toEqual([viewItem]);
		m.track(viewItem);
		expect(got).toHaveLength(2);
		// a second subscriber does not get the already-delivered early event
		const later: unknown[] = [];
		m.onAnalyticsEvent((e) => later.push(e));
		expect(later).toEqual([]);
	});

	it('no consent at subscription: early events are discarded, never sent later', () => {
		m.track(viewItem);
		const got: unknown[] = [];
		m.onAnalyticsEvent((e) => got.push(e));
		m.setAnalyticsConsent(true);
		expect(got).toEqual([]);
	});

	it('revoking consent drops held events; the hold is bounded', () => {
		m.track(viewItem);
		m.setAnalyticsConsent(false);
		m.setAnalyticsConsent(true);
		const got: unknown[] = [];
		m.onAnalyticsEvent((e) => got.push(e));
		expect(got).toEqual([]);
		m.setAnalyticsConsent(false);
		const fresh: unknown[] = [];
		// with a subscriber present and no consent, track is a no-op
		m.track(viewItem);
		expect(fresh).toEqual([]);
	});

	it('holds at most 20 events', async () => {
		for (let i = 0; i < 30; i++) m.track(viewItem);
		m.setAnalyticsConsent(true);
		const got: unknown[] = [];
		m.onAnalyticsEvent((e) => got.push(e));
		expect(got).toHaveLength(20);
	});
});
