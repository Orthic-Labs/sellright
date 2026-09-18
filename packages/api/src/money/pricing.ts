/**
 * Effective unit-price selection for a variant — server-authoritative, shared
 * by cart (estimate + persisted cart) and checkout so every surface prices the
 * same variant identically.
 *
 * The rule is store-config-driven via `store.config.pricing.variantRule` and
 * mirrors the source storefront each store was imported from:
 *
 *   'preorder' — Damned Designs parity (store/src/utils/effective-price.ts):
 *     while isPreOrder, a POSITIVE preOrderPrice wins; otherwise the base
 *     price — a preorder NEVER falls through to salePrice. Off-preorder
 *     variants use a positive salePrice else base.
 *   'sale' — Rotten Hand parity (EffectivePriceStrategy):
 *     positive salePrice else base. The preorder fields are ignored entirely.
 *
 * Zero/negative overrides are treated as ABSENT in both rules — the legacy
 * `!= null` check priced a variant at 0 whenever a store had salePrice set to
 * 0, which no source rule ever does.
 *
 * DEFAULT_VARIANT_PRICE_RULE is 'preorder': for a store that never touches
 * preorder fields it is identical to 'sale' (positive sale else base), and it
 * is the only rule that honors the preorder flag.
 */

export type VariantPriceRule = 'preorder' | 'sale';
export const DEFAULT_VARIANT_PRICE_RULE: VariantPriceRule = 'preorder';

export interface VariantPriceFields {
  price: number;
  salePrice: number | null;
  isPreOrder: boolean;
  preOrderPrice: number | null;
}

/** Read the store's price rule from store.config.pricing.variantRule. Unknown
 *  or absent values fall back to the default rule — never throw on config. */
export function variantPriceRuleFromConfig(config: unknown): VariantPriceRule {
  const rule = (config as { pricing?: { variantRule?: unknown } } | null | undefined)?.pricing?.variantRule;
  return rule === 'sale' || rule === 'preorder' ? rule : DEFAULT_VARIANT_PRICE_RULE;
}

/** Positive overrides only — 0 / negative / null all mean "not set". */
const positive = (n: number | null | undefined): number | null =>
  (typeof n === 'number' && n > 0 ? n : null);

export function selectUnitPrice(v: VariantPriceFields, rule: VariantPriceRule = DEFAULT_VARIANT_PRICE_RULE): number {
  if (rule === 'sale') return positive(v.salePrice) ?? v.price;
  if (v.isPreOrder) return positive(v.preOrderPrice) ?? v.price;
  return positive(v.salePrice) ?? v.price;
}
