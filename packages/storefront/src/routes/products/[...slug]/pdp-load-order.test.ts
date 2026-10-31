// @vitest-environment node
// Lane 11: no API call competes with the PDP's load. The LOCKED live stock read (qinit) starts first and never waits behind another
// read; prices and JSON-LD offers are ONE low-priority server$ call; shop config, session and reviews stay off the critical path.
// The qwikloader runs one document event's handlers in order and awaits each returned promise, so a qinit handler that returned a
// network read held every later one (the trace's session -> config -> reviews -> qfunc -> qfunc -> stock chain).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');
/** The source with comments removed, so an assertion never matches prose. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The qwikloader's dispatch model for one document event: handlers run in registration order, each returned promise awaited. */
async function dispatchQinit(handlers: (() => unknown)[]): Promise<void> {
	for (const h of handlers) {
		const r = h();
		if (r && typeof (r as Promise<unknown>).then === 'function') await r;
	}
}

describe('the PDP live stock read starts first and independently', () => {
	it('base PDP: the stock trigger is registered before the live values read; no config or session read in the component', () => {
		const s = code('routes/products/[...slug]/ProductContent.tsx');
		const stock = s.indexOf('usePdpStockTrigger(refreshLiveStock)');
		expect(stock).toBeGreaterThan(-1);
		expect(stock).toBeLessThan(s.indexOf('useLiveRead<'));
		for (const t of ['getShopConfig', 'fetchSessionCustomer', 'pageSessionCustomer', 'getProductReviews']) expect(s).not.toContain(t);
	});

	it('brand PDP (configurator): useConfigurator (stock trigger) registers before the live values read starts', () => {
		const s = code('platform/controllers/product.tsx');
		expect(s.indexOf("useConfigurator(")).toBeGreaterThan(-1);
		expect(s.indexOf("useConfigurator(")).toBeLessThan(s.indexOf('useLiveReadStart<'));
		expect(code('platform/controllers/configurator.ts')).toContain("useStockTrigger(mode === 'product' ? 'pdp' : 'shop', load)");
	});

	it('the stock trigger and the live read handlers start their read and return at once (never hold the qinit queue)', () => {
		expect(code('platform/stock-triggers.ts')).toContain("useOnDocument(page === 'pdp' ? PDP_STOCK_TRIGGER : 'qidle', $(() => { load(); }))");
		const lv = code('platform/live-values.ts');
		expect(lv).toContain("useOnDocument('qinit', $(() => { void start(); }))");
		expect(lv).not.toMatch(/useOnDocument\('qinit', start\)/);
	});

	it('model: with non-blocking handlers the stock request starts before a slow earlier read settles', async () => {
		const started: string[] = [];
		const slow = (name: string) => () => { started.push(name); return new Promise((r) => setTimeout(r, 50)); };
		const nonBlocking = (fn: () => unknown) => () => { void fn(); };
		// Before: blocking handlers chain the requests (each starts only after the previous response).
		const before: string[] = [];
		const t0 = Date.now();
		await dispatchQinit([() => { before.push('prices'); return new Promise((r) => setTimeout(r, 30)); }, () => { before.push(`stock@${Date.now() - t0 >= 25 ? 'late' : 'early'}`); }]);
		expect(before).toEqual(['prices', 'stock@late']);
		// After: stock first, the others never awaited.
		const t1 = Date.now();
		await dispatchQinit([nonBlocking(() => started.push(`stock@${Date.now() - t1}`)), nonBlocking(slow('values'))]);
		expect(started[0]).toMatch(/^stock@\d$/);
		expect(started[1]).toBe('values');
	});
});

describe('one server$ call for the live values (no duplicate qfunc on load)', () => {
	it('base PDP reads prices, related prices and JSON-LD offers in readProductValues; no separate offers read', () => {
		const s = code('routes/products/[...slug]/ProductContent.tsx');
		expect(s).not.toContain('useJsonLdOffersFill');
		expect(s).not.toContain('readProductOffers');
		expect(s.match(/useLiveRead</g)).toHaveLength(1);
		const p = code('platform/product.ts');
		expect(p).toMatch(/readProductValues = server\$\([\s\S]*?liveOffersOf\(slug\)[\s\S]*?\}, LIVE_READ_FETCH\);/);
		expect(p).toContain("fetchOptions: { priority: 'low' as const }");
	});

	it('brand PDP reads detail and offers in readBrandProductLive; no separate offers read', () => {
		const s = code('platform/controllers/product.tsx');
		expect(s).not.toContain('useJsonLdOffersFill');
		expect(s).not.toContain('readBrandProductDetail');
		expect(s.match(/readBrandProductLive\(/g)).toHaveLength(1);
		expect(code('platform/product-live.ts')).toMatch(/Promise\.all\(\[buildBrandProductDetail\(slug\)[\s\S]*liveOffersOf\(slug\)\]\)[\s\S]*\}, LIVE_READ_FETCH\);/);
	});
});

describe('shop config and reviews stay off the PDP critical path', () => {
	it('express buy-now and the loyalty line read the shared config only after interaction / load idle', () => {
		const e = code('components/checkout/ExpressBuyNow.tsx');
		expect(e.indexOf('await afterInteraction()')).toBeGreaterThan(-1);
		expect(e.indexOf('await afterInteraction()')).toBeLessThan(e.indexOf('getShopConfig()'));
		const l = code('components/loyalty/LoyaltyPdpEarn.tsx');
		expect(l.indexOf('await afterLoadIdleOrInteraction()')).toBeGreaterThan(-1);
		expect(l.indexOf('await afterLoadIdleOrInteraction()')).toBeLessThan(l.indexOf('loadLoyaltyProgram()'));
		expect(code('providers/shop/checkout/checkout.ts')).toContain("sellright().GET('/v1/shop/config', { priority: 'low' })");
	});

	it('reviews read only near the viewport, at low priority, set up at idle (not document-ready)', () => {
		const r = code('components/reviews/ProductReviews.tsx');
		expect(r).toContain('whenNearViewport(anchor.value');
		expect(r).toContain("priority: 'low'");
		expect(r).toContain("strategy: 'document-idle'");
		expect(r).not.toContain("strategy: 'document-ready'");
	});
});
