// Brand views PR2 §3, §5: the configurator's pure state and methods (no Qwik, no I/O). configurator.ts binds them to a store and
// the dispatcher. Every method validates its arguments against the store: a forged or out-of-range call returns `invalid` and
// changes nothing.
import { BRAND_ROUTES } from '~/platform/brand-data';
import type { ActionResult, AddResult, ProductSummary, PurchaseState, ViewProduct, ViewSelection } from '~/platform/views';
import type { ActionCtl } from './callbacks';
import { computePurchase, emptySelection, keepSelection, projectSummary, projectViewProduct, selectionFromQuery, type ModelProduct, type SelectedOptions } from './product-model';
import type { StockCtl } from './stock-read';

export const INVALID: ActionResult = { ok: false, reason: 'invalid' };
export const OK: ActionResult = { ok: true };

export interface ConfiguratorCtl extends ActionCtl, StockCtl {
	productKey: string | null;
	selected: SelectedOptions;
	quantity: number;
	consent: boolean;
	adding: boolean;
	last: AddResult | null;
}

/** What a mode reads from its loader value: the products it can sell, the slugs of its one live read, and its initial focus. */
export interface ConfiguratorSource {
	/** Every product the view can sell (PDP: the route product; shop: the detail products). */
	products: ModelProduct[];
	/** PDP siblings: shown, never read or sold. */
	siblings: ModelProduct[];
	/** True on the shop (a product must be selected); false on a PDP (the route product is always focused). */
	selectable: boolean;
}

/** The shop's initial product from the query (routes.json shop.productQuery): the first listed param present wins. */
export function productKeyFromQuery(query: { get(name: string): string | null }, products: readonly ModelProduct[], productQuery = BRAND_ROUTES?.shop?.productQuery): string | null {
	if (!productQuery) return null;
	for (const param of productQuery.params) {
		const raw = query.get(param);
		if (raw === null) continue;
		const key = productQuery.values[raw.toLowerCase()];
		return key && products.some((p) => p.key === key) ? key : null;
	}
	return null;
}

export function initialFocus(source: ConfiguratorSource, query: { get(name: string): string | null }): { productKey: string | null; selected: SelectedOptions } {
	const key = source.selectable ? productKeyFromQuery(query, source.products) : (source.products[0]?.key ?? null);
	const model = source.products.find((p) => p.key === key) ?? null;
	return { productKey: model ? model.key : null, selected: model ? selectionFromQuery(model, query) : [] };
}

export const focused = (ctl: ConfiguratorCtl, source: ConfiguratorSource): ModelProduct | null => source.products.find((p) => p.key === ctl.productKey) ?? null;

/** Units per SKU in the cart mirror (display and the cap; the server decides the add). */
const inCartOf = (lines: readonly { sku: string; quantity: number }[]): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const l of lines) out[l.sku] = (out[l.sku] ?? 0) + l.quantity;
	return out;
};

export interface ConfiguratorView {
	/** Every sellable product, projected with the current view's live stock (the focused one with the selection). */
	products: ViewProduct[];
	siblings: ProductSummary[];
	selection: ViewSelection;
	purchase: PurchaseState;
}

/** The whole configurator projection for the current state (pure). */
export function projectConfigurator(ctl: ConfiguratorCtl, source: ConfiguratorSource, cartLines: readonly { sku: string; quantity: number }[]): ConfiguratorView {
	const model = focused(ctl, source);
	const view = computePurchase({
		model,
		stock: model ? ctl.stock[model.slug] : undefined,
		selected: model ? ctl.selected : [],
		quantity: ctl.quantity,
		consent: ctl.consent,
		adding: ctl.adding,
		last: ctl.last,
		inCart: inCartOf(cartLines),
	});
	return {
		products: source.products.map((p) => projectViewProduct(p, ctl.stock[p.slug], p.key === ctl.productKey ? ctl.selected : emptySelection(p))),
		siblings: source.siblings.map(projectSummary),
		selection: { productKey: model ? model.key : null, ...view.selection },
		purchase: view.purchase,
	};
}

// ---------------------------------------------------------------------------------------------------- methods (plain; validated)

export function selectProduct(ctl: ConfiguratorCtl, source: ConfiguratorSource, key: unknown): ActionResult {
	if (!source.selectable || typeof key !== 'string') return INVALID;
	const model = source.products.find((p) => p.key === key);
	if (!model) return INVALID;
	ctl.productKey = model.key;
	ctl.selected = emptySelection(model);
	ctl.quantity = 1;
	ctl.consent = false;
	return OK;
}

export function selectOption(ctl: ConfiguratorCtl, source: ConfiguratorSource, group: unknown, value: unknown): ActionResult {
	const model = focused(ctl, source);
	if (!model || typeof group !== 'string' || (value !== null && typeof value !== 'string')) return INVALID;
	const i = model.groups.findIndex((g) => g.code === group);
	if (i < 0) return INVALID;
	if (value !== null && !model.groups[i].values.some((v) => v.code === value)) return INVALID;
	const next = ctl.selected.length === model.groups.length ? [...ctl.selected] : emptySelection(model);
	next[i] = value;
	ctl.selected = next;
	ctl.consent = false;
	return OK;
}

export function changeQuantity(ctl: ConfiguratorCtl, source: ConfiguratorSource, cartLines: readonly { sku: string; quantity: number }[], quantity: unknown): ActionResult {
	if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) return INVALID;
	const { purchase } = projectConfigurator(ctl, source, cartLines);
	if (quantity > purchase.maxQuantity) return INVALID;
	ctl.quantity = quantity;
	return OK;
}

export function changeConsent(ctl: ConfiguratorCtl, source: ConfiguratorSource, cartLines: readonly { sku: string; quantity: number }[], accepted: unknown): ActionResult {
	if (typeof accepted !== 'boolean') return INVALID;
	if (accepted) {
		const model = focused(ctl, source);
		const view = model
			? computePurchase({ model, stock: ctl.stock[model.slug], selected: ctl.selected, quantity: ctl.quantity, consent: false, adding: false, last: null, inCart: inCartOf(cartLines) })
			: null;
		// Only a resolved pre-order whose live read is in stock asks for consent.
		if (!view?.variant || !view.variant.isPreOrder || ctl.stock[model!.slug]?.bySku[view.variant.sku]?.inStock !== true) return INVALID;
	}
	ctl.consent = accepted;
	return OK;
}

/** The loader value of either mode, as a ConfiguratorSource. */
/** shop: the brand shop's products; product: one product page; spotlight: the brand home view's one product. */
export type ConfiguratorMode = 'shop' | 'product' | 'spotlight';

export function sourceOf(value: unknown, mode: ConfiguratorMode): ConfiguratorSource {
	if (mode === 'shop' || mode === 'spotlight') {
		// The shop chooses among its products; the home spotlight sells its one product, focused from the start.
		const v = value as { detail?: ModelProduct[] } | null;
		return { products: v?.detail ?? [], siblings: [], selectable: mode === 'shop' };
	}
	const v = value as { state?: string; product?: ModelProduct; siblings?: ModelProduct[] } | null;
	if (!v || v.state !== 'found' || !v.product) return { products: [], siblings: [], selectable: false };
	return { products: [v.product], siblings: v.siblings ?? [], selectable: false };
}

/** A complete selection that no longer resolves after a model change resets (partial ones are kept). */
export const reconcileSelection = (ctl: ConfiguratorCtl, source: ConfiguratorSource): void => {
	const model = focused(ctl, source);
	if (model) ctl.selected = keepSelection(model, ctl.selected);
};
