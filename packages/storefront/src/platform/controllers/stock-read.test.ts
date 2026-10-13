// @vitest-environment node
// Brand views PR2 §4: one automatic live read per view; superseded responses dropped; per-product failure isolation; no cache.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogStockResponse } from '~/sellright/types/catalog';
import { initialStockCtl, readStock, requestLoad, retryFailed, startNewView, type StockFetcher } from './stock-read';

type Pending = { slug: string; signal?: AbortSignal; resolve: (r: CatalogStockResponse | null) => void; reject: (e: unknown) => void };
function fakeFetcher() {
	const calls: Pending[] = [];
	const fetcher: StockFetcher = (slug, opts) =>
		new Promise((resolve, reject) => {
			calls.push({ slug, signal: opts.signal, resolve, reject });
		});
	return { calls, fetcher };
}
const stock = (sku: string, inStock: boolean): CatalogStockResponse => ({ slug: 'x', variants: [{ sku, inStock, availableQuantity: 5 }] }) as unknown as CatalogStockResponse;
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe('one automatic read per view', () => {
	it('two triggers in one view (qidle and the browser task) start one read; selections start none', async () => {
		const ctl = initialStockCtl();
		const { calls, fetcher } = fakeFetcher();
		const a = requestLoad(ctl, ['p'], fetcher);
		const b = requestLoad(ctl, ['p'], fetcher);
		expect(b).toBeNull();
		expect(calls).toHaveLength(1);
		calls[0].resolve(stock('S1', true));
		await a;
		expect(ctl.stock.p).toEqual({ status: 'ready', bySku: { S1: { inStock: true, availableQuantity: 5 } } });
		expect(requestLoad(ctl, ['p'], fetcher)).toBeNull();
		expect(calls).toHaveLength(1);
	});

	it('a new view (SPA navigation, same component, or back/forward) gets exactly one more read and aborts the old one, whose late response is dropped', async () => {
		const ctl = initialStockCtl();
		const { calls, fetcher } = fakeFetcher();
		const first = requestLoad(ctl, ['a'], fetcher);
		startNewView(ctl);
		expect(calls[0].signal?.aborted).toBe(true);
		expect(ctl.stock).toEqual({});
		const second = requestLoad(ctl, ['b'], fetcher);
		expect(calls).toHaveLength(2);
		calls[0].resolve(stock('OLD', true));
		expect(await first).toBe('dropped');
		expect(ctl.stock.a).toBeUndefined();
		calls[1].resolve(stock('NEW', false));
		expect(await second).toBe('applied');
		expect(ctl.stock.b.bySku.NEW.inStock).toBe(false);
	});

	it('an out-of-order response of an older read is dropped and never sets in-stock', async () => {
		const ctl = initialStockCtl();
		const { calls, fetcher } = fakeFetcher();
		const older = readStock(ctl, ['p'], fetcher);
		const newer = readStock(ctl, ['p'], fetcher);
		calls[1].resolve(stock('S1', false));
		await newer;
		calls[0].resolve(stock('S1', true));
		expect(await older).toBe('dropped');
		expect(ctl.stock.p.bySku.S1.inStock).toBe(false);
	});

	it('the shop reads every detail product under one generation; one failure leaves the sibling purchasable; 404 is out of stock', async () => {
		const ctl = initialStockCtl();
		const { calls, fetcher } = fakeFetcher();
		const read = requestLoad(ctl, ['short', 'long', 'gone'], fetcher);
		expect(calls.map((c) => c.slug)).toEqual(['short', 'long', 'gone']);
		expect(new Set(calls.map((c) => c.signal)).size).toBe(1);
		expect(ctl.stock.short.status).toBe('loading');
		calls[0].resolve(stock('S1', true));
		calls[1].reject(new Error('500'));
		calls[2].resolve(null);
		await read;
		expect(ctl.stock.short).toEqual({ status: 'ready', bySku: { S1: { inStock: true, availableQuantity: 5 } } });
		expect(ctl.stock.long.status).toBe('error');
		expect(ctl.stock.gone).toEqual({ status: 'ready', bySku: {} });
	});

	it('retry reads only the failed products, once', async () => {
		const ctl = initialStockCtl();
		const { calls, fetcher } = fakeFetcher();
		const read = requestLoad(ctl, ['a', 'b'], fetcher);
		calls[0].resolve(stock('A', true));
		calls[1].reject(new Error('timeout'));
		await read;
		const retry = retryFailed(ctl, fetcher);
		expect(calls.slice(2).map((c) => c.slug)).toEqual(['b']);
		calls[2].resolve(stock('B', true));
		await retry;
		expect(ctl.stock.b.status).toBe('ready');
		expect(ctl.stock.a.status).toBe('ready');
		expect(retryFailed(ctl, fetcher)).toBeNull();
	});

	it('writes no storage and keeps no module state for stock (no cache)', async () => {
		const setItem = vi.fn();
		vi.stubGlobal('sessionStorage', { setItem, getItem: () => null });
		vi.stubGlobal('localStorage', { setItem, getItem: () => null });
		const ctl = initialStockCtl();
		const { calls, fetcher } = fakeFetcher();
		const read = requestLoad(ctl, ['p'], fetcher);
		calls[0].resolve(stock('S', true));
		await read;
		await tick();
		expect(setItem).not.toHaveBeenCalled();
		const fresh = initialStockCtl();
		expect(fresh.stock).toEqual({});
		vi.unstubAllGlobals();
	});
});
