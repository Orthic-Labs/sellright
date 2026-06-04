/**
 * Money is ALWAYS integer minor units (cents). Never floats, never major units
 * inside the system. This is the foundation the money-core (totals/tax/refund)
 * builds on — see docs/BUILD-PLAN-RH-v1.md §3.
 */

/** Branded integer-cents type so a raw number can't be passed where cents are expected. */
export type Cents = number & { readonly __brand: 'Cents' };

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) {
    throw new Error(`Money must be integer cents, got ${n}`);
  }
  return n as Cents;
}

export const ZERO: Cents = 0 as Cents;

export function addCents(...values: Cents[]): Cents {
  return values.reduce((sum, v) => sum + v, 0) as Cents;
}

export function subCents(a: Cents, b: Cents): Cents {
  return (a - b) as Cents;
}

export function mulCents(value: Cents, qty: number): Cents {
  if (!Number.isInteger(qty)) {
    throw new Error(`Quantity must be an integer, got ${qty}`);
  }
  return (value * qty) as Cents;
}

/**
 * Percentage discount on a cents amount, rounded half-up to whole cents.
 * Rounding policy is centralized here so totals/tax/promotions never diverge.
 */
export function percentOf(value: Cents, percent: number): Cents {
  return Math.round((value * percent) / 100) as Cents;
}

/** Display helper only — formatting happens at the edge, never in core math. */
export function formatCents(value: Cents, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value / 100);
}
