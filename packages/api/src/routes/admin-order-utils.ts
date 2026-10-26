import { selectUnitPrice, DEFAULT_VARIANT_PRICE_RULE, type VariantPriceRule } from '../money/pricing.js';

export function inferCarrier(t: string): string | null {
  const x = t.replace(/\s/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(x)) return 'UPS';
  // #376: the previous admin importer's USPS rule (92/94 + 18–20 digits) before the FedEx 20–22 digit form.
  if (/^9[24]\d{18,20}$/.test(x)) return 'USPS';
  if (/^(94|93|92|95|420)\d{20,}$/.test(x) || /^[A-Z]{2}\d{9}US$/.test(x)) return 'USPS';
  if (/^\d{12}$/.test(x) || /^\d{15}$/.test(x) || /^\d{20,22}$/.test(x)) return 'FedEx';
  return null;
}

export const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function unitPrice(
  v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null },
  rule: VariantPriceRule = DEFAULT_VARIANT_PRICE_RULE,
): number {
  return selectUnitPrice(v, rule);
}
