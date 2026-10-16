// Brand views PR2 §5, §10: the pure product model behind the shop and product views. No Qwik, no I/O. The controllers keep a
// `ModelProduct` (metadata only) and the current view's live stock in their store; everything a view receives is projected here, field
// by field. Option groups and values carry a `code` (the slug of the name, Rotten's `optionCode`): codes are stable, readable deep-link
// and swatch keys, and every code maps back to exactly one catalog name, so variant resolution stays on the catalog's own names.
//
// LOCKED stock rule: only a live response of the current view can make a variant `in-stock`. A SKU absent from that response, a
// product the stock endpoint does not know (404), anything not read yet and anything that failed is not purchasable. `isPreOrder` is
// catalog metadata: it shows the pre-order label and asks for consent, it never makes an out-of-stock variant purchasable.
import { effectiveVariantPrice, type CatalogProduct, type CatalogStockResponse, type CatalogVariant } from '~/sellright/types/catalog';
import type { CartLineEnrichment } from '~/sellright/types/cart';
import { toSanitizedHtml, type SanitizedHtml } from '~/platform/sanitized';
import type { Availability, PurchaseReason, PurchaseState, ViewImage, ViewOptionGroup, ViewProduct, ViewSelection, ViewVariant, AddResult, ProductSummary } from '~/platform/views';

// ---------------------------------------------------------------------------------------------------- moved from product-options.ts

/**
 * Unique option groups, in the merchant's own order (API migration 0080:
 * `group.position` orders groups, `option.position` orders values within a
 * group — set via the admin's option-group/value reorder controls).
 *
 * Both are optional at runtime: a manifest snapshot published before this
 * field existed omits them, and this must still render sensibly rather than
 * throw or silently collapse everything to one order. When position data is
 * fully present (the normal case for anything touched after this shipped) it
 * is authoritative and NEVER overridden by name — a merchant who orders
 * values "L, M, S" or groups "Color, Size" must see exactly that, not an
 * alphabetical or size-heuristic re-sort. The size-word heuristic and
 * alphabetical-by-name sort below are legacy fallbacks ONLY for the
 * position-less case.
 */
export function getOptionGroups(variants: CatalogVariant[]): { groupName: string; values: string[] }[] {
  const map = new Map<string, { position: number | undefined; values: Map<string, number | undefined> }>();
  for (const v of variants) {
    for (const opt of (v.options || [])) {
      const g = opt.group?.name || 'Option';
      if (!map.has(g)) map.set(g, { position: opt.group?.position, values: new Map() });
      const entry = map.get(g)!;
      if (entry.position === undefined && opt.group?.position !== undefined) entry.position = opt.group.position;
      if (!entry.values.has(opt.name)) entry.values.set(opt.name, opt.position);
    }
  }
  const SIZE_ORDER = ['xs', 'xsmall', 'x-small', 's', 'sm', 'small', 'm', 'md', 'medium', 'l', 'lg', 'large', 'xl', 'xxl', '2xl', '3xl'];
  const groups = Array.from(map.entries()).map(([groupName, { position, values }]) => {
    const names = [...values.keys()];
    const hasAllValuePositions = names.length > 0 && [...values.values()].every((p) => p !== undefined);
    let sorted = names;
    if (hasAllValuePositions) {
      sorted = [...names].sort((a, b) => values.get(a)! - values.get(b)!);
    } else if (groupName.toLowerCase() === 'size') {
      sorted = [...names].sort((a, b) => {
        const ai = SIZE_ORDER.indexOf(a.toLowerCase());
        const bi = SIZE_ORDER.indexOf(b.toLowerCase());
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }
    return { groupName, values: sorted, position };
  });
  const hasAllGroupPositions = groups.length > 0 && groups.every((g) => g.position !== undefined);
  const ordered = hasAllGroupPositions
    ? [...groups].sort((a, b) => a.position! - b.position!)
    : [...groups].sort((a, b) => a.groupName.localeCompare(b.groupName));
  return ordered.map(({ groupName, values }) => ({ groupName, values }));
}

/** Find the resolved variant from all selected values */
export function findVariant(
  variants: CatalogVariant[],
  groups: { groupName: string; values: string[] }[],
  selected: (string | null)[],
): CatalogVariant | undefined {
  // Single variant with no option groups — return it directly
  if (groups.length === 0) return variants[0];
  if (selected.some(v => !v)) return undefined;
  return variants.find(v =>
    v.options && groups.every((g, i) =>
      v.options!.find(o => o.group?.name === g.groupName)?.name === selected[i]
    )
  );
}

/** Cart boundary: translate the native product/variant into the cart's
 *  client-only display enrichment (`~/sellright/types/cart`). This is the
 *  ONLY place in the catalog area that builds it — everything upstream of it
 *  stays native, and the server cart line itself carries only `sku`/`quantity`. */
export function toCartEnrichment(product: Pick<CatalogProduct, 'slug'>, variant: Pick<CatalogVariant, 'name' | 'options' | 'isPreOrder' | 'shipDate'>, image: { preview: string } | undefined): CartLineEnrichment {
  return {
    slug: product.slug,
    image: image?.preview ?? null,
    name: variant.name,
    options: variant.options.map((o) => o.name).join(' / '),
    isPreOrder: variant.isPreOrder,
    shipDate: variant.shipDate ?? undefined,
  };
}

// ---------------------------------------------------------------------------------------------------- the model

/** Rotten's `optionCode`: lower-case, runs of whitespace to one hyphen. */
export const slugCode = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '-');

export interface ModelValue { code: string; name: string }
export interface ModelGroup { code: string; name: string; values: ModelValue[] }
export interface ModelVariant {
  sku: string;
  name: string;
  /** Codes, one per group, in group order. */
  options: { group: string; value: string }[];
  priceCents: number;
  salePriceCents: number | null;
  preOrderPriceCents: number | null;
  isPreOrder: boolean;
  shipDate: string | null;
  images: ViewImage[];
  /** The enrichment's option label (`S / Black`), from the catalog names. */
  optionLabel: string;
}
/** Metadata only: no stock field exists here. JSON-shaped, so a controller store can hold it. */
export interface ModelProduct {
  key: string;
  slug: string;
  name: string;
  href: string;
  description: SanitizedHtml;
  images: ViewImage[];
  groups: ModelGroup[];
  variants: ModelVariant[];
  currencyCode: string;
  rating: { average: number; count: number } | null;
  productId: string | null;
}

export interface SkuStock { inStock: boolean; availableQuantity: number | null }
/** One product's live stock in the CURRENT view: `bySku` is filled only from a response of the current read. */
export interface ProductStock { status: 'unchecked' | 'loading' | 'ready' | 'error'; bySku: Record<string, SkuStock> }
export const UNCHECKED: ProductStock = { status: 'unchecked', bySku: {} };

/** Unique codes for names in order: a name whose slug is already taken (by an earlier name or an earlier generated suffix) gets the
 *  first free `-2`, `-3`, ... so no two values share a code. */
function uniqueCodes(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = slugCode(name) || 'option';
    let code = base;
    for (let n = 2; used.has(code); n++) code = `${base}-${n}`;
    used.add(code);
    return code;
  });
}

/** The model of one catalog product (manifest-normalised or live detail; its stock fields are ignored). */
export function buildModelProduct(product: CatalogProduct, meta: { key: string; href: string; rating: { average: number; count: number } | null; productId: string | null }): ModelProduct {
  const raw = getOptionGroups(product.variants);
  const groupCodes = uniqueCodes(raw.map((g) => g.groupName));
  const groups: ModelGroup[] = raw.map((g, i) => {
    const codes = uniqueCodes(g.values);
    return { code: groupCodes[i], name: g.groupName, values: g.values.map((name, j) => ({ code: codes[j], name })) };
  });
  const codeFor = (groupName: string, valueName: string): { group: string; value: string } | null => {
    const g = groups.find((x) => x.name === groupName);
    const v = g?.values.find((x) => x.name === valueName);
    return g && v ? { group: g.code, value: v.code } : null;
  };
  const variants: ModelVariant[] = product.variants.map((v) => {
    const pairs: { group: string; value: string }[] = [];
    for (const g of groups) {
      const opt = (v.options || []).find((o) => (o.group?.name || 'Option') === g.name);
      const pair = opt ? codeFor(g.name, opt.name) : null;
      if (pair) pairs.push(pair);
    }
    return {
      sku: String(v.sku),
      name: String(v.name),
      options: pairs,
      priceCents: Number(v.price) || 0,
      salePriceCents: typeof v.salePrice === 'number' ? v.salePrice : null,
      preOrderPriceCents: typeof v.preOrderPrice === 'number' ? v.preOrderPrice : null,
      isPreOrder: v.isPreOrder === true,
      shipDate: v.shipDate ?? null,
      images: (v.assets || []).filter((a) => !!a?.preview).map((a) => ({ url: String(a.preview), alt: null })),
      optionLabel: (v.options || []).map((o) => o.name).join(' / '),
    };
  });
  return {
    key: meta.key,
    slug: String(product.slug),
    name: String(product.name),
    href: meta.href,
    description: toSanitizedHtml(product.description ?? '', 'product'),
    images: (product.images || []).map((url) => ({ url: String(url), alt: null })),
    groups,
    variants,
    currencyCode: String(product.currency || 'USD'),
    rating: meta.rating ? { average: meta.rating.average, count: meta.rating.count } : null,
    productId: meta.productId,
  };
}

/** availableQuantity is null (uncapped) or a finite non-negative integer; anything else is malformed. */
const validQuantity = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);

/** A stock response applied to one product: `inStock === true` only; a SKU the response omits stays absent (= out of stock). */
export function stockFromResponse(response: CatalogStockResponse | null): ProductStock {
  const bySku: Record<string, SkuStock> = {};
  if (response !== null && (typeof response !== 'object' || !Array.isArray((response as { variants?: unknown }).variants))) {
    throw new Error('malformed stock response'); // the caller turns this into that product's `error` (fail closed, retryable)
  }
  for (const v of response?.variants ?? []) {
    if (!v || typeof v.sku !== 'string') continue;
    // A malformed quantity (missing, negative, fractional, non-numeric) fails the SKU closed: not in stock, nothing to add.
    bySku[v.sku] = validQuantity(v.availableQuantity)
      ? { inStock: v.inStock === true, availableQuantity: v.availableQuantity }
      : { inStock: false, availableQuantity: 0 };
  }
  return { status: 'ready', bySku };
}

/** A variant's availability in the current view. */
export function variantAvailability(stock: ProductStock | undefined, sku: string): Availability {
  const s = stock ?? UNCHECKED;
  if (s.status !== 'ready') return s.status === 'error' ? 'error' : s.status;
  return s.bySku[sku]?.inStock === true ? 'in-stock' : 'out-of-stock';
}

/** Selected value codes in group order (null = unselected). */
export type SelectedOptions = (string | null)[];

export const emptySelection = (model: ModelProduct | null): SelectedOptions => (model ? model.groups.map(() => null) : []);

/** The variant a complete selection resolves to (a product without option groups resolves to its one variant). */
export function resolveVariant(model: ModelProduct, selected: SelectedOptions): ModelVariant | null {
  if (model.groups.length === 0) return model.variants[0] ?? null;
  if (selected.length !== model.groups.length || selected.some((v) => v === null)) return null;
  return model.variants.find((v) => model.groups.every((g, i) => v.options.find((o) => o.group === g.code)?.value === selected[i])) ?? null;
}

/** A value's availability given the OTHER selected groups (Rotten: a size is available when any colour of it is in stock). */
export function valueAvailability(model: ModelProduct, stock: ProductStock | undefined, selected: SelectedOptions, groupIndex: number, valueCode: string): Availability {
  const s = stock ?? UNCHECKED;
  if (s.status !== 'ready') return s.status === 'error' ? 'error' : s.status;
  const group = model.groups[groupIndex];
  const any = model.variants.some((v) => {
    if (v.options.find((o) => o.group === group.code)?.value !== valueCode) return false;
    for (let i = 0; i < model.groups.length; i++) {
      if (i === groupIndex || selected[i] == null) continue;
      if (v.options.find((o) => o.group === model.groups[i].code)?.value !== selected[i]) return false;
    }
    return s.bySku[v.sku]?.inStock === true;
  });
  return any ? 'in-stock' : 'out-of-stock';
}

/** `in-stock` when any variant's live read is in stock (never from the pre-order flag). */
export function productAvailability(model: ModelProduct, stock: ProductStock | undefined): Availability {
  const s = stock ?? UNCHECKED;
  if (s.status !== 'ready') return s.status === 'error' ? 'error' : s.status;
  return model.variants.some((v) => s.bySku[v.sku]?.inStock === true) ? 'in-stock' : 'out-of-stock';
}

/** The unit price a variant is sold at (sale / pre-order / regular), as the views show it. */
export const effectivePriceOf = (v: Pick<ModelVariant, 'priceCents' | 'salePriceCents' | 'preOrderPriceCents' | 'isPreOrder'>): number =>
  effectiveVariantPrice({ price: v.priceCents, salePrice: v.salePriceCents, preOrderPrice: v.preOrderPriceCents, isPreOrder: v.isPreOrder });

function priceRange(model: ModelProduct): { minCents: number; maxCents: number } {
  const prices = model.variants.map(effectivePriceOf);
  return prices.length ? { minCents: Math.min(...prices), maxCents: Math.max(...prices) } : { minCents: 0, maxCents: 0 };
}

/** The view of one product in the current view, field by field. */
export function projectViewProduct(model: ModelProduct, stock: ProductStock | undefined, selected: SelectedOptions): ViewProduct {
  const optionGroups: ViewOptionGroup[] = model.groups.map((g, i) => ({
    code: g.code,
    name: g.name,
    values: g.values.map((v) => ({ code: v.code, name: v.name, availability: valueAvailability(model, stock, selected, i, v.code) })),
  }));
  const variants: ViewVariant[] = model.variants.map((v) => ({
    sku: v.sku,
    name: v.name,
    options: v.options.map((o) => ({ group: o.group, value: o.value })),
    priceCents: v.priceCents,
    salePriceCents: v.salePriceCents,
    preOrderPriceCents: v.preOrderPriceCents,
    isPreOrder: v.isPreOrder,
    shipDate: v.shipDate,
    images: v.images.map((im) => ({ url: im.url, alt: im.alt })),
    availability: variantAvailability(stock, v.sku),
  }));
  return {
    key: model.key,
    slug: model.slug,
    name: model.name,
    href: model.href,
    description: { kind: 'sanitized-html', html: model.description.html },
    images: model.images.map((im) => ({ url: im.url, alt: im.alt })),
    optionGroups,
    variants,
    priceRange: priceRange(model),
    currencyCode: model.currencyCode,
    availability: productAvailability(model, stock),
    rating: model.rating ? { average: model.rating.average, count: model.rating.count } : null,
    productId: model.productId,
  };
}

/** A sibling on a product page: no stock. */
export function projectSummary(model: ModelProduct): ProductSummary {
  return {
    key: model.key,
    slug: model.slug,
    name: model.name,
    href: model.href,
    image: model.images[0]?.url ?? null,
    priceRange: priceRange(model),
    currencyCode: model.currencyCode,
  };
}

// ---------------------------------------------------------------------------------------------------- purchase

export const MAX_ADD_QUANTITY = 10;

export interface PurchaseInput {
  /** Shop: a product must be focused first. PDP: always true. */
  model: ModelProduct | null;
  stock: ProductStock | undefined;
  selected: SelectedOptions;
  /** The quantity the shopper asked for (normalised here). */
  quantity: number;
  consent: boolean;
  adding: boolean;
  last: AddResult | null;
  /** Units per SKU in the cart mirror (display and the cap only; the server decides). */
  inCart: Record<string, number>;
}

export interface PurchaseView {
  purchase: PurchaseState;
  selection: Omit<ViewSelection, 'productKey'>;
  /** The resolved variant when eligible-or-not; null when the selection is incomplete or does not resolve. */
  variant: ModelVariant | null;
}

/** Units the shopper may add now: 10 when uncapped; else the live available units minus what the cart holds, 0..10. */
export function maxQuantityFor(skuStock: SkuStock | undefined, inCart: number): number {
  if (!skuStock || skuStock.inStock !== true) return 0;
  if (skuStock.availableQuantity === null) return MAX_ADD_QUANTITY;
  return Math.max(0, Math.min(MAX_ADD_QUANTITY, skuStock.availableQuantity - inCart));
}

/** A requested quantity normalised into 1..max(1, maxQuantity) (a selection or a limit change never leaves it out of range). */
export const normaliseQuantity = (requested: number, maxQuantity: number): number => {
  const q = Number.isInteger(requested) ? requested : 1;
  return Math.max(1, Math.min(q, Math.max(1, maxQuantity)));
};

/** The purchase state of the focused selection, in the order of §5: the first reason that applies, or eligible. */
export function computePurchase(input: PurchaseInput): PurchaseView {
  const { model, stock, selected } = input;
  const s = stock ?? UNCHECKED;
  const stockState: PurchaseState['stock'] = s.status;
  const variant = model ? resolveVariant(model, selected) : null;
  const skuStock = variant && s.status === 'ready' ? s.bySku[variant.sku] : undefined;
  const inCartQuantity = variant ? input.inCart[variant.sku] ?? 0 : 0;
  const maxQuantity = variant && s.status === 'ready' ? maxQuantityFor(skuStock, inCartQuantity) : 0;
  const complete = !!model && (model.groups.length === 0 || (selected.length === model.groups.length && selected.every((v) => v !== null)));
  const activePreOrder = !!variant && variant.isPreOrder && skuStock?.inStock === true;

  let reason: PurchaseReason | null = null;
  if (input.adding) reason = 'adding';
  else if (!model) reason = 'select-product';
  else if (s.status === 'unchecked' || s.status === 'loading') reason = 'stock-loading';
  else if (s.status === 'error') reason = 'stock-error';
  else if (!complete) reason = 'select-options';
  else if (!variant || skuStock?.inStock !== true) reason = 'out-of-stock';
  else if (maxQuantity === 0) reason = 'in-cart-limit';
  else if (activePreOrder && !input.consent) reason = 'consent-required';

  return {
    purchase: {
      stock: stockState,
      eligible: reason === null,
      reason,
      adding: input.adding,
      last: input.last,
      inCartQuantity,
      maxQuantity,
    },
    selection: {
      options: model ? model.groups.map((g, i) => ({ group: g.code, value: selected[i] ?? null })) : [],
      variantSku: variant ? variant.sku : null,
      quantity: normaliseQuantity(input.quantity, maxQuantity),
      preOrderConsent: activePreOrder ? input.consent : false,
    },
    variant,
  };
}

/** A complete selection that no longer resolves (after a model change) resets; a partial one is never wiped. */
export function keepSelection(model: ModelProduct, selected: SelectedOptions): SelectedOptions {
  if (selected.length !== model.groups.length) return emptySelection(model);
  const valid = selected.map((v, i) => (v !== null && model.groups[i].values.some((x) => x.code === v) ? v : null));
  const complete = valid.every((v) => v !== null);
  if (complete && model.groups.length > 0 && !resolveVariant(model, valid)) return emptySelection(model);
  return valid;
}

/**
 * Query preselection (§10): each param named like a group code (lower-case) whose value is one of that group's value codes, or a value
 * whose slug matches, preselects it. Unknown params and values are ignored. Runs on the server, before any stock is known.
 */
export function selectionFromQuery(model: ModelProduct, query: { get(name: string): string | null }): SelectedOptions {
  return model.groups.map((g) => {
    const raw = query.get(g.code);
    if (!raw) return null;
    const wanted = slugCode(raw);
    return g.values.find((v) => v.code === wanted)?.code ?? null;
  });
}

/** The enrichment for a resolved variant (cart drawer display). */
export function enrichmentFor(model: ModelProduct, variant: ModelVariant): CartLineEnrichment {
  return {
    slug: model.slug,
    image: variant.images[0]?.url ?? model.images[0]?.url ?? null,
    name: variant.name,
    options: variant.optionLabel,
    isPreOrder: variant.isPreOrder,
    shipDate: variant.shipDate ?? undefined,
  };
}

// ---------------------------------------------------------------------------------------------------- add outcome

export const CART_CHANGED_MESSAGE = 'Your cart changed in another tab. Please try again.';

/** The AddResult of one add, from that add's own outcome only. A 200 append adds exactly `quantity` units (cart.ts append contract). */
export function addResultFrom(
	outcome: { kind: 'applied'; line: { quantity: number; available: boolean; availableQuantity: number | null } | null } | { kind: 'not-applied' } | { kind: 'error'; message: string | null },
	sku: string,
	quantity: number,
): AddResult {
	if (outcome.kind === 'error') return { status: 'rejected', reason: 'cart-error', message: outcome.message ?? null };
	if (outcome.kind === 'not-applied') return { status: 'rejected', reason: 'cart-changed', message: CART_CHANGED_MESSAGE };
	const line = outcome.line;
	if (!line) return { status: 'rejected', reason: 'cart-error', message: null };
	const fits = line.availableQuantity === null || line.availableQuantity >= line.quantity;
	if (line.available === true && fits) return { status: 'added', sku, quantity, lineQuantity: line.quantity };
	return { status: 'added-unavailable', sku, quantity, lineQuantity: line.quantity, availableQuantity: line.availableQuantity };
}
