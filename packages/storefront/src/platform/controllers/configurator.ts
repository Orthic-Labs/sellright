// Brand views PR2 §3-§5, §10: the configurator controller shared by the shop and product views. It owns the selection, the view's one
// live stock read (stock-read.ts), the purchase state and the add. Every action goes through `dispatch` (callbacks.ts): validated
// against this store, applied in call order, a result rebuilt from its fixed schema. A forged or out-of-range call returns `invalid`
// (or `not-eligible` for an add) with no state change and no request.
import { $, useContext, useStore, useTask$, useVisibleTask$, type ReadonlySignal } from '@qwik.dev/core';
import { isBrowser } from '@qwik.dev/core/build';
import { useLocation } from '@qwik.dev/router';
import { APP_STATE } from '~/constants';
import { addToCartWithOutcome, useCart } from '~/contexts/CartContext';
import { loadCountryOnDemand } from '~/utils/addressStorage';
import { fetchProductStock } from '~/sellright/catalog';
import { track } from '~/sellright/analytics';
import { ADD_RESULT } from '~/platform/gateway/actions';
import type { ActionResult, AddResult } from '~/platform/views';
import { ACTION_RESULTS, dispatch, type DispatchResults } from './callbacks';
import { addResultFrom, effectivePriceOf, enrichmentFor } from './product-model';
import { INVALID, OK, changeConsent, changeQuantity, focused, initialFocus, projectConfigurator, selectOption, selectProduct, sourceOf, type ConfiguratorCtl, type ConfiguratorView } from './configurator-model';

export type { ConfiguratorCtl, ConfiguratorSource, ConfiguratorView } from './configurator-model';
import { abortStockRead, initialStockCtl, readStock, requestLoad, retryFailed, startNewView } from './stock-read';
import { useBfcacheStockRefresh, useStockTrigger } from '~/platform/stock-triggers';
import { seal } from './project';
import type { BrandProductDetail } from '~/platform/product-detail';
import type { ConfiguratorDetail } from '~/platform/configurator-detail';

export const ADD_RESULTS: DispatchResults<AddResult> = {
	busy: { status: 'rejected', reason: 'busy', message: null },
	disposed: { status: 'rejected', reason: 'disposed', message: null },
	error: { status: 'rejected', reason: 'error', message: null },
	schema: ADD_RESULT,
};

// ---------------------------------------------------------------------------------------------------- the hook

/**
 * The configurator for one mounted view. `source` is the loader value (a new value = a new view). `toSource` maps it to the products
 * the view can sell. Returns the projection signal and the bound methods (QRLs a mount wraps with `platformAction`).
 */
export type ConfiguratorLoaderValue = BrandProductDetail | ConfiguratorDetail | null;

export function useConfigurator(loader: ReadonlySignal<ConfiguratorLoaderValue>, mode: 'shop' | 'product') {
	const appState = useContext(APP_STATE);
	const cart = useCart();
	const location = useLocation();
	const first = sourceOf(loader.value, mode);
	const start = initialFocus(first, location.url.searchParams);
	const ctl = useStore<ConfiguratorCtl>({
		disposed: false,
		admitted: [],
		...initialStockCtl(),
		productKey: start.productKey,
		selected: start.selected,
		quantity: 1,
		consent: false,
		adding: false,
		last: null,
	});

	/** The view's automatic read (direct load: qidle; SPA navigation: the task below). One per view, whichever fires first. */
	const load = $(() => {
		const source = sourceOf(loader.value, mode);
		const started = requestLoad(ctl, source.products.map((p) => p.slug), fetchProductStock);
		if (started && mode === 'product') {
			const p = source.products[0];
			const v = p?.variants[0];
			if (p && v) track({ name: 'view_item', sku: v.sku, productName: p.name, price: effectivePriceOf(v), currency: p.currencyCode });
		}
	});

	// A new loader value in the browser is a new view (same component, SPA navigation). At a client-side mount this is the first run.
	useTask$(({ track: tracked }) => {
		const value = tracked(() => loader.value);
		const href = tracked(() => location.url.href);
		// The view's identity is its query (a query-only navigation such as ?style=short → ?style=long is a new view even though the loader
		// does not re-run) and its products, not the loader object: resuming the page re-delivers the same loader value and must not count
		// as a new view (that would start a second read).
		const url = new URL(href);
		// The path is not in the key: a path change always brings new products (a new loader value), and keying on both would count one
		// navigation twice when the location and the loader update in separate rounds.
		const key = `${url.search}|${sourceOf(value, mode).products.map((p) => p.slug).join(',')}`;
		if (ctl.viewKey !== null && ctl.viewKey !== key) {
			startNewView(ctl);
			const focus = initialFocus(sourceOf(value, mode), url.searchParams);
			ctl.productKey = focus.productKey;
			ctl.selected = focus.selected;
			ctl.quantity = 1;
			ctl.consent = false;
			ctl.last = null;
		}
		ctl.viewKey = key;
		if (isBrowser) load();
	});
	// The automatic read's document event: the PDP follows pdp.stockRefreshTrigger, the shop stays on qidle.
	useStockTrigger(mode === 'product' ? 'pdp' : 'shop', load);
	// pdp.bfcacheRefresh: a restored page reads its products again (same view, same selection; a live read like any other).
	const reread = $(() => { void readStock(ctl, sourceOf(loader.value, mode).products.map((p) => p.slug), fetchProductStock); });
	useBfcacheStockRefresh(reread, mode === 'product' ? 'pdp' : 'shop');
	useVisibleTask$(({ cleanup }) => cleanup(() => { ctl.disposed = true; abortStockRead(ctl); }));

	/** The projection for this render (the mount calls it in its render body: a computed read inside another computed lost its
	 *  captures in the production build, Qwik 2 rc). It reads the store, the loader and the cart mirror, so a change re-renders. */
	const project = (): ConfiguratorView => seal(projectConfigurator(ctl, sourceOf(loader.value, mode), cart.cart.lines)) as ConfiguratorView;

	const onProductSelect$ = $((key: string) => dispatch<ActionResult>(ctl, null, ACTION_RESULTS, () => selectProduct(ctl, sourceOf(loader.value, mode), key)));
	const onOptionSelect$ = $((group: string, value: string | null) => dispatch<ActionResult>(ctl, null, ACTION_RESULTS, () => selectOption(ctl, sourceOf(loader.value, mode), group, value)));
	const onQuantityChange$ = $((quantity: number) => dispatch<ActionResult>(ctl, null, ACTION_RESULTS, () => changeQuantity(ctl, sourceOf(loader.value, mode), cart.cart.lines, quantity)));
	const onConsentChange$ = $((accepted: boolean) => dispatch<ActionResult>(ctl, null, ACTION_RESULTS, () => changeConsent(ctl, sourceOf(loader.value, mode), cart.cart.lines, accepted)));
	const onRetryStock$ = $(() =>
		dispatch<ActionResult>(ctl, 'stock', ACTION_RESULTS, () => {
			const model = focused(ctl, sourceOf(loader.value, mode));
			if (!model || ctl.stock[model.slug]?.status !== 'error') return INVALID;
			void retryFailed(ctl, fetchProductStock);
			return OK;
		}),
	);
	const onAddToCart$ = $(() =>
		dispatch<AddResult>(ctl, 'add', ADD_RESULTS, async () => {
			const source = sourceOf(loader.value, mode);
			const model = focused(ctl, source);
			const now = projectConfigurator(ctl, source, cart.cart.lines);
			const variant = model ? model.variants.find((v) => v.sku === now.selection.variantSku) ?? null : null;
			const quantity = now.selection.quantity;
			if (!model || !variant || !now.purchase.eligible || !Number.isInteger(quantity) || quantity < 1 || quantity > now.purchase.maxQuantity) {
				const rejected: AddResult = { status: 'rejected', reason: 'not-eligible', message: null };
				ctl.last = rejected;
				return rejected;
			}
			ctl.adding = true;
			let result: AddResult;
			try {
				result = addResultFrom(await addToCartWithOutcome(cart, variant.sku, quantity, enrichmentFor(model, variant)), variant.sku, quantity);
			} finally {
				ctl.adding = false;
			}
			ctl.last = result;
			if (result.status === 'added' || result.status === 'added-unavailable') {
				appState.showCart = true;
				loadCountryOnDemand(appState);
				announce(`${model.name} added to cart`);
				track({ name: 'add_to_cart', sku: variant.sku, productName: model.name, price: effectivePriceOf(variant), currency: model.currencyCode, quantity });
			}
			return result;
		}),
	);

	return { ctl, project, onProductSelect$, onOptionSelect$, onQuantityChange$, onConsentChange$, onRetryStock$, onAddToCart$ };
}

/** A polite live-region message (as the base PDP posts on add). */
function announce(text: string): void {
	if (typeof document === 'undefined') return;
	const el = document.createElement('div');
	el.setAttribute('role', 'status');
	el.setAttribute('aria-live', 'polite');
	el.className = 'sr-only';
	el.textContent = text;
	document.body.appendChild(el);
	setTimeout(() => el.remove(), 3000);
}

