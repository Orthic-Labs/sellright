// @vitest-environment jsdom
// #425 (fallback (b)): GTM starts on the first interaction only. The ecommerce dataLayer push happens at once; the sink beacon (the
// GA4 Measurement Protocol copy) waits until it is known whether GTM ran: gtagSent once it does, the copy only when the page is left
// without it. Never both.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/platform/brand-data', () => ({
	BRAND_HEAD: { analytics: { provider: 'gtm', containerId: 'GTM-TEST', consent: 'implied' } },
	BRAND_ROUTES: {},
}));

type W = { dataLayer?: Array<{ event?: string }>; google_tag_manager?: unknown };
const win = () => window as unknown as W;

async function fresh() {
	vi.resetModules();
	win().dataLayer = [];
	delete win().google_tag_manager;
	const conversion = await import('./conversion');
	const analytics = await import('~/sellright/analytics');
	conversion.startConversion();
	return { conversion, analytics };
}

const viewItem = { name: 'view_item', sku: 'SKU-1', productName: 'Knife', price: 12_500, currency: 'USD' } as const;

describe('conversion beacon waits for GTM (#425)', () => {
	let beacons: Array<{ name: string; gtagSent: boolean }>;
	beforeEach(() => {
		vi.useFakeTimers();
		beacons = [];
		Object.defineProperty(navigator, 'sendBeacon', {
			configurable: true,
			value: (_url: string, body: Blob) => { void body.text().then((t) => { const e = JSON.parse(t).event; beacons.push({ name: e.name, gtagSent: e.gtagSent }); }); return true; },
		});
	});
	afterEach(() => { vi.useRealTimers(); delete win().google_tag_manager; });

	it('pushes to the dataLayer at once, then beacons with gtagSent once GTM runs (the sink sends no copy)', async () => {
		const { analytics } = await fresh();
		analytics.track(viewItem as never);
		expect(win().dataLayer!.some((e) => e.event === 'view_item')).toBe(true);
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.waitFor(() => expect(beacons).toEqual([]));
		win().google_tag_manager = {};
		await vi.advanceTimersByTimeAsync(600);
		vi.useRealTimers();
		await vi.waitFor(() => expect(beacons).toEqual([{ name: 'view_item', gtagSent: true }]));
	});

	it('leaving the page without GTM (no interaction) beacons gtagSent false: the sink sends the one copy', async () => {
		const { analytics } = await fresh();
		analytics.track(viewItem as never);
		analytics.track({ name: 'begin_checkout', value: 12_500, currency: 'USD', items: [] } as never);
		await vi.advanceTimersByTimeAsync(1_000);
		window.dispatchEvent(new Event('pagehide'));
		vi.useRealTimers();
		await vi.waitFor(() => expect(beacons).toEqual([{ name: 'view_item', gtagSent: false }, { name: 'begin_checkout', gtagSent: false }]));
	});

	it('gtmDelivers: immediate when GTM already runs; one shared watcher', async () => {
		const { conversion } = await fresh();
		const a = conversion.gtmDelivers(window);
		const b = conversion.gtmDelivers(window);
		expect(a).toBe(b);
		win().google_tag_manager = {};
		await vi.advanceTimersByTimeAsync(500);
		await expect(a).resolves.toBe(true);
		await expect(conversion.gtmDelivers(window)).resolves.toBe(true);
	});
});
