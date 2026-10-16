// Brand views PR2 §4: the live stock read of the shop and product views. One automatic read per view (a direct load or an SPA
// navigation), covering every product the view can sell; option selection, product selection and add never start one (the add's own
// server response is the live check for that SKU). Retry is explicit and only after an error.
//
// LOCKED stock rule: results live only in the controller store of the current view. Nothing is written to sessionStorage,
// localStorage, a module cache or the manifest; there is no TTL, debounce or "loaded" flag (`lastLoadGen` is a per-view generation
// check, reset by navigation). A response applies only when its read is still the latest (`stockGen`) and its view is still current
// (`viewGen`); anything else is dropped and can never make a variant purchasable. Per product: 200 → the response (a SKU it omits is
// out of stock), 404 → every variant out of stock, a throw/5xx/timeout → that product `error`. Missing stock fails closed.
import type { CatalogStockResponse } from '~/sellright/types/catalog';
import { stockFromResponse, type ProductStock } from './product-model';

export interface StockCtl {
	/** Increments when the view's key changes in the browser (a new view of the same component). SSR serialises 1. */
	viewGen: number;
	/** The view that already got its automatic read. */
	lastLoadGen: number;
	/** Increments per read; a response applies only if it is still the latest. */
	stockGen: number;
	/** The current view's key (path and products), set during SSR or at a client-side mount; null before the first run. */
	viewKey: string | null;
	/** Live stock of the current view, per product slug. Absent = unchecked. */
	stock: Record<string, ProductStock>;
}

export type StockFetcher = (slug: string, opts: { signal?: AbortSignal }) => Promise<CatalogStockResponse | null>;

export const initialStockCtl = (): StockCtl => ({ viewGen: 1, lastLoadGen: 0, stockGen: 0, viewKey: null, stock: {} });

// Browser-only, per controller store: the in-flight read's AbortController. A WeakMap, as callbacks.ts keeps its chains.
const inflight = new WeakMap<object, AbortController>();

/** Aborts the in-flight read of this controller, if any. */
export function abortStockRead(ctl: object): void {
	inflight.get(ctl)?.abort();
	inflight.delete(ctl);
}

/** A new view (same component, new loader value): abort, forget every result, next automatic read allowed. */
export function startNewView(ctl: StockCtl): void {
	abortStockRead(ctl);
	ctl.viewGen++;
	ctl.stock = {};
}

/** One live read of `slugs` (one request each, one AbortController, one generation). Resolves when applied or dropped. */
export async function readStock(ctl: StockCtl, slugs: readonly string[], fetcher: StockFetcher): Promise<'applied' | 'dropped'> {
	const viewGen = ctl.viewGen;
	const reqGen = ++ctl.stockGen;
	abortStockRead(ctl);
	const ac = new AbortController();
	inflight.set(ctl, ac);
	const loading: Record<string, ProductStock> = { ...ctl.stock };
	for (const slug of slugs) loading[slug] = { status: 'loading', bySku: {} };
	ctl.stock = loading;
	// Tagged per-product outcomes: one product failing never discards a sibling's live result.
	const outcomes = await Promise.all(
		slugs.map((slug) =>
			fetcher(slug, { signal: ac.signal }).then(
				(response) => ({ slug, ok: true as const, response }),
				() => ({ slug, ok: false as const }),
			),
		),
	);
	if (reqGen !== ctl.stockGen || viewGen !== ctl.viewGen || ac.signal.aborted) return 'dropped';
	inflight.delete(ctl);
	const next: Record<string, ProductStock> = { ...ctl.stock };
	for (const o of outcomes) {
		let applied: ProductStock = { status: 'error', bySku: {} };
		if (o.ok) {
			try {
				applied = stockFromResponse(o.response);
			} catch {
				// a malformed body fails closed for this product only; its siblings keep their live result, and retry can re-read it
			}
		}
		next[o.slug] = applied;
	}
	ctl.stock = next;
	return 'applied';
}

/** The view's automatic read: a no-op when this view already started one (whichever trigger came first). */
export function requestLoad(ctl: StockCtl, slugs: readonly string[], fetcher: StockFetcher): Promise<'applied' | 'dropped'> | null {
	if (ctl.lastLoadGen === ctl.viewGen) return null;
	ctl.lastLoadGen = ctl.viewGen; // set before any await: two triggers in one view start one read
	return readStock(ctl, slugs, fetcher);
}

/** Explicit retry after an error: one new read of the products that failed. Null when nothing failed. */
export function retryFailed(ctl: StockCtl, fetcher: StockFetcher): Promise<'applied' | 'dropped'> | null {
	const failed = Object.entries(ctl.stock).filter(([, s]) => s.status === 'error').map(([slug]) => slug);
	if (failed.length === 0) return null;
	return readStock(ctl, failed, fetcher);
}
