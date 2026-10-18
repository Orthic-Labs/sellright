import { vendureLineMoney, type ImportedLineMoney } from './vendure-money.js';

/** Quote JSON numeric tokens before parsing: persisted cents must not lose their
 * source lexemes before validation (including numbers nested in simple-json). */
function exactJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g,
    token => token.startsWith('"') ? token : JSON.stringify(token)));
}

export function vendureSourceRecord(value: unknown): Record<string, unknown> {
  const record = exactJson(value);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid Vendure financial source record');
  return record as Record<string, unknown>;
}

export function vendureSourceInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value))) {
    throw new Error(`Invalid Vendure financial integer: ${field}`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`Unsafe Vendure financial integer: ${field}`);
  return result;
}

export function vendureMoneySum(values: readonly number[]): number {
  return values.reduce((sum, value) => vendureSourceInteger(sum + value, 'aggregate'), 0);
}

function decimalIdentity(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid Vendure tax rate');
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('Unsafe Vendure tax rate');
  const digits = (match[2]! + (match[3] ?? '')).replace(/^0+/, '').replace(/0+$/, '');
  if (!digits) return '0';
  const trailing = (match[2]! + (match[3] ?? '')).replace(/^0+/, '').length - digits.length;
  return `${match[1]}${digits}e${exponent + trailing}`;
}

function taxRate(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid Vendure tax rate');
  const rate = Number(value);
  if (!Number.isFinite(rate) || Math.abs(rate) > Number.MAX_SAFE_INTEGER || decimalIdentity(String(value)) !== decimalIdentity(String(rate))) {
    throw new Error('Unsafe Vendure tax rate');
  }
  return rate;
}

function array(value: unknown, field: string): Record<string, unknown>[] {
  const rows = exactJson(value);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`Invalid Vendure financial array: ${field}`);
  }
  return rows as Record<string, unknown>[];
}

function priceInput(raw: Record<string, unknown>) {
  const listPrice = vendureSourceInteger(raw.listPrice, 'listPrice');
  if (typeof raw.listPriceIncludesTax !== 'boolean') throw new Error('Invalid Vendure listPriceIncludesTax');
  const taxLines = array(raw.taxLines, 'taxLines').map(row => ({ ...row, taxRate: taxRate(row.taxRate) }));
  const rate = taxLines.reduce((sum, row) => sum + row.taxRate, 0);
  if (!Number.isFinite(rate) || (100 + rate) / 100 <= 0) throw new Error('Invalid Vendure tax factor');
  return { listPrice, listPriceIncludesTax: raw.listPriceIncludesTax, taxLines, rate };
}

function adjustments(value: unknown) {
  return array(value, 'adjustments').map(row => ({ ...row, amount: vendureSourceInteger(row.amount, 'adjustment.amount') }));
}

/** Existing merchandise getter, after rejecting coercions & unsafe lexemes.
 * Explicit placed=0 remains a source fact; Vendure uses max(placed,current). */
export function vendureExactLineMoney(raw: Record<string, unknown>): {
  quantity: number; placedQuantity: number; money: ImportedLineMoney;
  listPrice: number; listPriceIncludesTax: boolean; adjustments: Record<string, unknown>[]; taxLines: Record<string, unknown>[];
} {
  const { listPrice, listPriceIncludesTax, taxLines } = priceInput(raw);
  const quantity = vendureSourceInteger(raw.quantity, 'quantity');
  const placedQuantity = raw.orderPlacedQuantity == null ? quantity : vendureSourceInteger(raw.orderPlacedQuantity, 'orderPlacedQuantity');
  if (quantity < 0 || placedQuantity < 0) throw new Error('Invalid Vendure financial quantity');
  const lineAdjustments = adjustments(raw.adjustments);
  const money = vendureLineMoney({ quantity, orderPlacedQuantity: placedQuantity, listPrice, listPriceIncludesTax,
    adjustments: lineAdjustments, taxLines });
  Object.entries(money).forEach(([key, value]) => vendureSourceInteger(value, key));
  return { quantity, placedQuantity, money, listPrice, listPriceIncludesTax, adjustments: lineAdjustments, taxLines };
}

export type VendureChargeMoney = { sourceId: string; net: number; gross: number };
export function vendureSurchargeMoney(raw: Record<string, unknown>): VendureChargeMoney & { label: string } {
  const input = priceInput(raw);
  if (typeof raw.description !== 'string') throw new Error('Invalid Vendure surcharge description');
  return { ...roundedPair(raw.id, input.listPrice, input.listPriceIncludesTax, input.rate), label: raw.description };
}

export function vendureShippingMoney(raw: Record<string, unknown>): VendureChargeMoney {
  const input = priceInput(raw);
  const amount = vendureMoneySum([input.listPrice, ...adjustments(raw.adjustments).map(row => row.amount)]);
  return roundedPair(raw.id, amount, input.listPriceIncludesTax, input.rate);
}

function roundedPair(id: unknown, amount: number, includesTax: boolean, rate: number): VendureChargeMoney {
  const identity = String(id);
  if (!/^[1-9][0-9]*$/.test(identity)) throw new Error('Invalid Vendure financial source identity');
  const factor = (100 + rate) / 100;
  return { sourceId: identity,
    net: vendureSourceInteger(Math.round(includesTax ? amount / factor : amount), 'net'),
    gross: vendureSourceInteger(Math.round(includesTax ? amount : amount * factor), 'gross') };
}

export type VendureFinancialHeader = { subTotal: number; subTotalWithTax: number; shipping: number; shippingWithTax: number };
export function vendureOrderChargeProjection(input: {
  lines: readonly ImportedLineMoney[]; surcharges: readonly VendureChargeMoney[]; shipping: readonly VendureChargeMoney[];
  header: VendureFinancialHeader; netSettled?: number;
}) {
  const merchandiseNet = vendureMoneySum(input.lines.map(line => line.lineSubtotal - line.lineDiscount));
  const merchandiseGross = vendureMoneySum(input.lines.map(line => line.lineTotal));
  const surchargeNet = vendureMoneySum(input.surcharges.map(row => row.net));
  const surchargeGross = vendureMoneySum(input.surcharges.map(row => row.gross));
  const shippingNet = vendureMoneySum(input.shipping.map(row => row.net));
  const shippingGross = vendureMoneySum(input.shipping.map(row => row.gross));
  const expected = { subTotal: vendureMoneySum([merchandiseNet, surchargeNet]),
    subTotalWithTax: vendureMoneySum([merchandiseGross, surchargeGross]), shipping: shippingNet, shippingWithTax: shippingGross };
  const grandTotal = vendureMoneySum([merchandiseGross, surchargeGross, shippingGross]);
  const status = Object.entries(expected).every(([key, value]) => input.header[key as keyof VendureFinancialHeader] === value)
    ? 'exact-header' : input.netSettled !== undefined && input.netSettled === grandTotal ? 'settled-corroborated' : 'unresolved';
  return { status, expected, adjustmentTotal: surchargeNet,
    totals: { subtotal: vendureMoneySum(input.lines.map(line => line.lineSubtotal)),
      discountTotal: vendureMoneySum(input.lines.map(line => line.lineDiscount)), shippingTotal: shippingNet,
      taxTotal: vendureMoneySum([merchandiseGross - merchandiseNet, surchargeGross - surchargeNet, shippingGross - shippingNet]), grandTotal } };
}
