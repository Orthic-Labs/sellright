// ADR-0001 §2-§3 (lane S2): the cacheable shell carries no price and no stock. With SHELL_CACHE=1 a shell route's loaders return their
// values redacted (`shellRender()`), the page reserves their space, and the browser reads them on load through a no-store request
// (`useLiveRead`). With the switch off (default) the loaders return exactly what they returned before and no extra read starts.
//
// LOCKED stock rules: nothing here caches, debounces or stores a value. A read lives in the current view's store only, a newer view's
// read always wins (generation), and a failed read is out of stock (fail closed). A redacted item carries the fail-closed constant
// (`inStock: false`), never a stock value, and the views show it as "not known yet" (no Sold Out, no In stock) until the read lands.
import { $, useOnDocument, useStore, useTask$, type QRL, type ReadonlySignal } from '@qwik.dev/core';
import { isBrowser } from '@qwik.dev/core/build';
import type { CatalogPricingVariant } from '~/sellright/types/catalog';

/** The value-bearing fields of a listing card (catalog list, search and collection items share them). */
export interface ValuedItem {
	slug: string;
	inStock: boolean;
	minPrice: number | null;
	maxPrice?: number | null;
	pricingVariant: CatalogPricingVariant | null;
}

// ---------------------------------------------------------------------------------------------------- pure: card values

/** The live values of one listing card (price and availability), keyed by product slug in a read's result. */
export interface CardValues {
	price: number | null;
	maxPrice: number | null;
	salePrice: number | null;
	preOrderPrice: number | null;
	isPreOrder: boolean;
	inStock: boolean;
}

/** A product the read did not return (or a failed read): no price, out of stock. */
export const FAIL_CLOSED_VALUES: CardValues = Object.freeze({ price: null, maxPrice: null, salePrice: null, preOrderPrice: null, isPreOrder: false, inStock: false });

export const cardValuesOf = (p: ValuedItem): CardValues => ({
	price: p.pricingVariant?.price ?? p.minPrice ?? null,
	maxPrice: p.maxPrice ?? null,
	salePrice: p.pricingVariant?.salePrice ?? null,
	preOrderPrice: p.pricingVariant?.preOrderPrice ?? null,
	isPreOrder: !!p.pricingVariant?.isPreOrder,
	inStock: p.inStock === true,
});

/** Card values per slug of a live read's items. */
export const valuesBySlug = (items: readonly ValuedItem[]): Record<string, CardValues> => {
	const out: Record<string, CardValues> = {};
	for (const item of items) if (item && typeof item.slug === 'string') out[item.slug] = cardValuesOf(item);
	return out;
};

/** A listing item for the shell: metadata kept (slug, name, image, tags), every price and the stock flag removed (fail-closed constant). */
export const redactListItem = <T extends ValuedItem>(p: T): T => ({ ...p, inStock: false, minPrice: null, maxPrice: null, pricingVariant: null });

/** The item with the live values of its slug applied; a slug the read did not return is fail closed. */
export const withCardValues = <T extends ValuedItem>(p: T, values: Record<string, CardValues>): T => {
	const v = Object.prototype.hasOwnProperty.call(values, p.slug) ? values[p.slug] : FAIL_CLOSED_VALUES;
	return {
		...p,
		inStock: v.inStock,
		minPrice: v.price,
		maxPrice: v.maxPrice,
		pricingVariant: v.price === null ? null : {
			sku: p.pricingVariant?.sku ?? p.slug,
			price: v.price,
			salePrice: v.salePrice,
			preOrderPrice: v.preOrderPrice,
			isPreOrder: v.isPreOrder,
			shipDate: p.pricingVariant?.shipDate ?? null,
			shipDateLabel: p.pricingVariant?.shipDateLabel ?? null,
		},
	};
};

/** The card props of an item under a live read: `pending` until the read settles, `pricePending` until it succeeded. */
export function cardState(status: LiveReadStatus, deferred: boolean): { pending: boolean; pricePending: boolean } {
	if (!deferred) return { pending: false, pricePending: false };
	return { pending: status === 'idle' || status === 'loading', pricePending: status !== 'ready' };
}

/** Figure spaces: digit-wide blanks that hold a price's place in the shell (no digits, so nothing reads as a price). */
export const PRICE_PLACEHOLDER = '    ';

// ---------------------------------------------------------------------------------------------------- the browser read

export type LiveReadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface LiveReadState<T> {
	status: LiveReadStatus;
	value: T | null;
	/** The view key the current read belongs to (a newer view always starts its own read). */
	key: string | null;
	gen: number;
}

/** Applies one read's outcome: only the latest generation of the current key applies. Pure (unit-tested). */
export function settleLiveRead<T>(state: LiveReadState<T>, gen: number, key: string, outcome: { ok: true; value: T } | { ok: false }): boolean {
	if (gen !== state.gen || key !== state.key) return false;
	state.value = outcome.ok ? outcome.value : null;
	state.status = outcome.ok ? 'ready' : 'error';
	return true;
}

/**
 * One no-store read of a shell route's live values per view. `viewKey` is null when the page needs none (the loader returned its
 * values, SHELL_CACHE off): nothing is read. Otherwise the read starts when the document is ready (qinit) on a direct load, and from a
 * browser task at a client-side mount or when the key changes (an SPA navigation); a key's read starts once. A read that resolves null
 * or throws is `error` (the caller fails closed).
 */
export function useLiveRead<T>(read: QRL<() => Promise<T | null>>, viewKey: ReadonlySignal<string | null>): LiveReadState<T> {
	const state = useStore<LiveReadState<T>>({ status: 'idle', value: null, key: null, gen: 0 });
	const start = $(async () => {
		const key = viewKey.value;
		if (key === null || state.key === key) return;
		const gen = ++state.gen;
		state.key = key;
		state.value = null;
		state.status = 'loading';
		let outcome: { ok: true; value: T } | { ok: false } = { ok: false };
		try {
			const value = await read();
			if (value !== null && value !== undefined) outcome = { ok: true, value };
		} catch (error) {
			console.error('[live-values] read failed', error);
		}
		settleLiveRead(state, gen, key, outcome);
	});
	useTask$(({ track }) => {
		const key = track(() => viewKey.value);
		if (key === null) {
			state.key = null;
			state.value = null;
			state.status = 'idle';
			state.gen++;
			return;
		}
		if (isBrowser) start();
	});
	useOnDocument('qinit', start);
	return state;
}

// ---------------------------------------------------------------------------------------------------- pure: PDP variant prices

/** The variants with the live price fields of their SKU (a SKU the read did not return keeps its fields: the shell's 0, never shown
 *  while the page's prices are pending). Stock fields are untouched (the live stock read owns them). */
export function applyVariantPrices<V extends { sku: string; price: number; salePrice: number | null; preOrderPrice: number | null }>(
	variants: readonly V[],
	prices: readonly { sku: string; price: number; salePrice: number | null; preOrderPrice: number | null }[],
): V[] {
	const bySku = new Map(prices.map((p) => [p.sku, p] as const));
	return variants.map((v) => {
		const p = bySku.get(v.sku);
		return p ? { ...v, price: p.price, salePrice: p.salePrice, preOrderPrice: p.preOrderPrice } : v;
	});
}
