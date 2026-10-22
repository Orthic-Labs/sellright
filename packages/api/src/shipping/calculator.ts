/**
 * Server-side shipping rate + eligibility.
 *
 * The admin stores a `calculator` JSON blob per shipping method. This module is
 * the single source of truth for interpreting it — both the storefront
 * "eligible methods" list and the authoritative checkout rate go through here,
 * so a client can never dictate its own shipping price.
 *
 * Calculator shape (all amounts integer cents):
 *   { flat?, min?, max?, countries?[], exclude? }
 *     flat       flat rate charged when eligible (default 0)
 *     min/max    inclusive subtotal bounds for eligibility (cents)
 *     countries  ISO-3166 alpha-2 list; allow-list by default
 *     exclude    when true, `countries` is a block-list instead
 *
 * Future calculators (weight tiers, per-item, carrier API) extend this shape;
 * keep the function signatures stable so callers don't change.
 */
export type ShippingCalculator = {
  flat?: number;
  min?: number;
  max?: number;
  countries?: string[];
  exclude?: boolean;
  requireCountry?: boolean;
  subtotalBasis?: 'pre_discount' | 'discounted_with_tax';
  taxRate?: number;
  taxInclusive?: boolean;
};

export type ShippingContext = {
  /** ISO-3166 alpha-2, upper- or lower-case; compared case-insensitively. */
  country?: string | null;
  /** Pre-discount line subtotal in integer cents. */
  subtotal: number;
  discountedSubtotalWithTax?: number;
};

function norm(c: unknown): ShippingCalculator {
  return (c && typeof c === 'object' ? (c as ShippingCalculator) : {});
}

/** Is this method offered for the given cart context? */
export function isMethodEligible(calculator: unknown, ctx: ShippingContext): boolean {
  const calc = norm(calculator);
  const subtotal = calc.subtotalBasis === 'discounted_with_tax' ? ctx.discountedSubtotalWithTax : ctx.subtotal;
  if (subtotal == null || !Number.isSafeInteger(subtotal) || subtotal < 0) return false;
  if (calc.requireCountry && !ctx.country?.trim()) return false;
  if (calc.min != null && subtotal < calc.min) return false;
  if (calc.max != null && subtotal > calc.max) return false;
  if (calc.countries && (calc.countries.length || calc.requireCountry)) {
    const country = ctx.country?.trim().toUpperCase() ?? '';
    const list = calc.countries.map((x) => x.trim().toUpperCase());
    const inList = country !== '' && list.includes(country);
    // allow-list: must be in list; block-list (exclude): must NOT be in list.
    if (calc.exclude ? inList : !inList) return false;
  }
  return true;
}

/** The charge for this method, in integer cents (never negative). */
export function shippingRate(calculator: unknown): number {
  const calc = norm(calculator);
  return Math.max(0, Math.round(calc.flat ?? 0));
}

/** Thrown inside the checkout txn when no valid shipping rate can be resolved. */
export class ShippingUnavailableError extends Error {
  constructor(public reason: 'method_not_found' | 'not_eligible' | 'method_required' | 'not_configured') {
    super(`shipping unavailable: ${reason}`);
    this.name = 'ShippingUnavailableError';
  }
}

/** Combined eligibility + rate for a single method. */
export function evaluateShipping(
  calculator: unknown,
  ctx: ShippingContext,
): { eligible: boolean; rate: number } {
  return { eligible: isMethodEligible(calculator, ctx), rate: shippingRate(calculator) };
}

/**
 * The nearest free-shipping tier for this cart's destination: the zero-rate method's minimum (cents) and how far the cart is
 * from it on that method's own subtotal basis, or null when shipping is already free or no free tier is reachable. "Spend X more for free shipping" hints read this, so storefronts
 * never carry thresholds of their own. Each method is judged on its own subtotal basis.
 */
export function freeShippingThreshold(calculators: readonly unknown[], ctx: ShippingContext): { threshold: number; remaining: number } | null {
  let best: { threshold: number; remaining: number } | null = null;
  for (const raw of calculators) {
    const calc = norm(raw);
    if (shippingRate(calc) !== 0) continue;
    if (isMethodEligible(calc, ctx)) return null; // already free
    const basis = calc.subtotalBasis === 'discounted_with_tax' ? ctx.discountedSubtotalWithTax : ctx.subtotal;
    if (calc.min == null || basis == null || basis >= calc.min) continue; // ineligible for a reason other than the minimum
    // Would the method be eligible once the basis reaches its minimum? (country, max and requireCountry still apply.)
    if (!isMethodEligible(calc, { ...ctx, subtotal: calc.min, discountedSubtotalWithTax: calc.min })) continue;
    const remaining = calc.min - basis;
    if (best === null || remaining < best.remaining) best = { threshold: calc.min, remaining };
  }
  return best;
}
