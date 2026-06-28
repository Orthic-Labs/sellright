import { randomUUID } from 'node:crypto';

export const orderCode = () => ('SR' + randomUUID().replace(/-/g, '').slice(0, 10)).toUpperCase();

export function inferCarrier(t: string): string | null {
  const x = t.replace(/\s/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(x)) return 'UPS';
  if (/^(94|93|92|95|420)\d{20,}$/.test(x) || /^[A-Z]{2}\d{9}US$/.test(x)) return 'USPS';
  if (/^\d{12}$/.test(x) || /^\d{15}$/.test(x) || /^\d{20,22}$/.test(x)) return 'FedEx';
  return null;
}

export const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function unitPrice(v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }): number {
  if (v.isPreOrder && v.preOrderPrice != null) return v.preOrderPrice;
  if (v.salePrice != null) return v.salePrice;
  return v.price;
}
