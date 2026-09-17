/**
 * Unit tests for the store-config-driven variant price selector (pricing
 * parity fix). The two rules mirror the source storefronts the stores were
 * imported from:
 *
 *   'preorder' (Damned Designs — store/src/utils/effective-price.ts):
 *     while isPreOrder, a POSITIVE preOrderPrice wins; otherwise base price —
 *     it NEVER falls through to salePrice. Off-preorder variants use a
 *     positive salePrice else base.
 *   'sale' (Rotten Hand — EffectivePriceStrategy):
 *     positive salePrice else base. Preorder fields are ignored entirely.
 *
 * In BOTH rules zero/negative overrides are treated as absent — the legacy
 * selector wrongly priced a variant at 0 whenever salePrice was set to 0.
 */
import { describe, expect, it } from 'vitest';
import { selectUnitPrice, variantPriceRuleFromConfig, DEFAULT_VARIANT_PRICE_RULE } from './pricing.js';

const V = (price: number, salePrice: number | null, isPreOrder = false, preOrderPrice: number | null = null) =>
  ({ price, salePrice, isPreOrder, preOrderPrice });

describe("variantPriceRuleFromConfig", () => {
  it("defaults to 'preorder' when config/key is absent or unknown", () => {
    expect(variantPriceRuleFromConfig(null)).toBe('preorder');
    expect(variantPriceRuleFromConfig(undefined)).toBe('preorder');
    expect(variantPriceRuleFromConfig({})).toBe('preorder');
    expect(variantPriceRuleFromConfig({ pricing: {} })).toBe('preorder');
    expect(variantPriceRuleFromConfig({ pricing: { variantRule: 'bogus' } })).toBe('preorder');
    expect(DEFAULT_VARIANT_PRICE_RULE).toBe('preorder');
  });
  it("reads config.pricing.variantRule === 'sale'", () => {
    expect(variantPriceRuleFromConfig({ pricing: { variantRule: 'sale' } })).toBe('sale');
    expect(variantPriceRuleFromConfig({ pricing: { variantRule: 'preorder' } })).toBe('preorder');
  });
});

describe("selectUnitPrice — 'preorder' rule (Damned Designs parity)", () => {
  const rule = 'preorder' as const;
  it('base price when nothing special is set', () => {
    expect(selectUnitPrice(V(5000, null), rule)).toBe(5000);
  });
  it('positive salePrice wins off-preorder', () => {
    expect(selectUnitPrice(V(5000, 4000), rule)).toBe(4000);
  });
  it('while preordering, a positive preOrderPrice wins', () => {
    expect(selectUnitPrice(V(5000, null, true, 3000), rule)).toBe(3000);
  });
  it('while preordering, NO positive preOrderPrice falls back to BASE — never to salePrice', () => {
    // The verified divergence: legacy code returned salePrice (4000) here.
    expect(selectUnitPrice(V(5000, 4000, true, null), rule)).toBe(5000);
    expect(selectUnitPrice(V(5000, 4000, true, 0), rule)).toBe(5000);
    expect(selectUnitPrice(V(5000, 4000, true, -100), rule)).toBe(5000);
  });
  it('a zero/negative salePrice is treated as absent (base, not 0)', () => {
    expect(selectUnitPrice(V(5000, 0), rule)).toBe(5000);
    expect(selectUnitPrice(V(5000, -1), rule)).toBe(5000);
  });
  it('a zero preOrderPrice is treated as absent even with no salePrice', () => {
    expect(selectUnitPrice(V(5000, null, true, 0), rule)).toBe(5000);
  });
});

describe("selectUnitPrice — 'sale' rule (Rotten Hand parity)", () => {
  const rule = 'sale' as const;
  it('positive salePrice wins; preorder fields are ignored', () => {
    expect(selectUnitPrice(V(5000, 4000, true, 3000), rule)).toBe(4000);
  });
  it('base when no positive salePrice — even when flagged preorder with a preOrderPrice', () => {
    expect(selectUnitPrice(V(5000, null, true, 3000), rule)).toBe(5000);
    expect(selectUnitPrice(V(5000, 0, true, 3000), rule)).toBe(5000);
  });
  it('a zero/negative salePrice is treated as absent', () => {
    expect(selectUnitPrice(V(5000, 0), rule)).toBe(5000);
    expect(selectUnitPrice(V(5000, -50), rule)).toBe(5000);
  });
});
