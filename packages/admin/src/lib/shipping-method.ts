/**
 * Shipping method editor model. The API stores one `calculator` JSON blob per
 * method (api/src/shipping/calculator.ts is the interpreter); this module
 * converts it to/from a form-friendly shape and writes the plain-language
 * summary shown in the list and the drawer. Unknown calculator keys are
 * preserved on save so an older admin never drops a newer calculator field.
 */
export type CountryMode = 'all' | 'only' | 'except';
export type SubtotalBasis = 'pre_discount' | 'discounted_with_tax';

export interface Calculator {
  flat?: number; min?: number; max?: number; countries?: string[]; exclude?: boolean;
  requireCountry?: boolean; subtotalBasis?: SubtotalBasis; [k: string]: unknown;
}

export interface MethodForm {
  name: string; code: string; enabled: boolean;
  rate: string; min: string; max: string; basis: SubtotalBasis;
  countryMode: CountryMode; countries: string; requireCountry: boolean;
}

const dollars = (cents: number | undefined) => (cents == null ? '' : (cents / 100).toFixed(2));
const toCents = (v: string): number | undefined => {
  const t = v.trim().replace(/[$,]/g, '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

export function formFromMethod(m: { name: string; code: string; enabled: boolean; calculator: unknown }): MethodForm {
  const c = (m.calculator && typeof m.calculator === 'object' ? m.calculator : {}) as Calculator;
  const list = Array.isArray(c.countries) ? c.countries : [];
  return {
    name: m.name, code: m.code, enabled: m.enabled,
    rate: dollars(c.flat ?? 0), min: dollars(c.min), max: dollars(c.max),
    basis: c.subtotalBasis === 'discounted_with_tax' ? 'discounted_with_tax' : 'pre_discount',
    countryMode: list.length === 0 ? 'all' : c.exclude ? 'except' : 'only',
    countries: list.join(', '), requireCountry: !!c.requireCountry,
  };
}

export const emptyForm = (): MethodForm => ({
  name: '', code: '', enabled: true, rate: '0.00', min: '', max: '', basis: 'pre_discount', countryMode: 'all', countries: '', requireCountry: false,
});

export function parseCountries(v: string): string[] {
  return [...new Set(v.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
}

export function validateForm(f: MethodForm): string[] {
  const errs: string[] = [];
  if (!f.name.trim()) errs.push('Name is required.');
  if (!f.code.trim()) errs.push('Code is required.');
  const rate = toCents(f.rate); const min = toCents(f.min); const max = toCents(f.max);
  if (rate === undefined || Number.isNaN(rate) || rate < 0) errs.push('Rate must be an amount of 0 or more.');
  if (Number.isNaN(min) || (min ?? 0) < 0) errs.push('Minimum subtotal must be an amount of 0 or more.');
  if (Number.isNaN(max) || (max ?? 0) < 0) errs.push('Maximum subtotal must be an amount of 0 or more.');
  if (min != null && max != null && !Number.isNaN(min) && !Number.isNaN(max) && min > max) errs.push('Minimum subtotal cannot be higher than the maximum.');
  if (f.countryMode !== 'all') {
    const list = parseCountries(f.countries);
    if (list.length === 0) errs.push('Add at least one country, or choose "All countries".');
    const bad = list.filter((c) => !/^[A-Z]{2}$/.test(c));
    if (bad.length) errs.push(`Use 2-letter country codes (US, CA, PR). Not recognised: ${bad.join(', ')}.`);
  }
  return errs;
}

/** Merge the edited form over the existing calculator, preserving unknown keys. */
export function calculatorFromForm(f: MethodForm, existing?: unknown): Calculator {
  const base: Calculator = existing && typeof existing === 'object' ? { ...(existing as Calculator) } : {};
  const min = toCents(f.min); const max = toCents(f.max);
  base.flat = toCents(f.rate) ?? 0;
  if (min != null) base.min = min; else delete base.min;
  if (max != null) base.max = max; else delete base.max;
  base.subtotalBasis = f.basis;
  if (f.countryMode === 'all') { delete base.countries; delete base.exclude; }
  else { base.countries = parseCountries(f.countries); base.exclude = f.countryMode === 'except'; }
  if (f.requireCountry) base.requireCountry = true; else delete base.requireCountry;
  return base;
}

function regionName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; } catch { return code; }
}
const listNames = (codes: string[]) => {
  const n = codes.map((c) => regionName(c.toUpperCase()));
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};
const fmt = (cents: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

/** One-sentence description of what a method does, in the owner's words. */
export function summarizeCalculator(calc: unknown, currency = 'USD'): string {
  const c = (calc && typeof calc === 'object' ? calc : {}) as Calculator;
  const rate = Math.max(0, Math.round(c.flat ?? 0));
  const parts: string[] = [rate === 0 ? 'Free shipping' : `${fmt(rate, currency)} flat rate`];
  const basis = c.subtotalBasis === 'discounted_with_tax' ? 'subtotal after discounts, including tax' : 'subtotal before discounts';
  if (c.min != null && c.max != null) parts.push(`when the ${basis} is ${fmt(c.min, currency)} to ${fmt(c.max, currency)} (both included)`);
  else if (c.min != null) parts.push(`when the ${basis} is ${fmt(c.min, currency)} or more`);
  else if (c.max != null) parts.push(`when the ${basis} is up to ${fmt(c.max, currency)}`);
  const list = Array.isArray(c.countries) ? c.countries : [];
  if (list.length) parts.push(c.exclude ? `everywhere except ${listNames(list)}` : `to ${listNames(list)} only`);
  else parts.push('to every country');
  if (c.requireCountry) parts.push('(needs a destination country)');
  return parts.join(' · ');
}

export function buildMethodPayload(f: MethodForm, existing?: unknown) {
  return { name: f.name.trim(), code: f.code.trim(), enabled: f.enabled, calculator: calculatorFromForm(f, existing) };
}
