/** Retained source order-edit facts, decoded only at import boundary. */
import { canonicalCouponCodes, type StackLine } from '../money/promotion-stack.js';
import { OrderEditStackError, orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { vendureLineMoney, type VendureLineSnapshotInput } from './vendure-money.js';
import { migrationId } from './context.js';
const MAX = 2_147_483_647;
function requireFact(ok: unknown, message: string): asserts ok {
  if (!ok) throw new OrderEditStackError('ORDER_EDIT_STACK_BASIS_INVALID', message);
}
function money(value: unknown, label: string, signed = false): asserts value is number {
  requireFact(typeof value === 'number' && Number.isSafeInteger(value) && value >= (signed ? -MAX : 0) && value <= MAX, `Invalid ${label}`);
}
type ImportedNativeLine = { id: string; orderId: string; storeId: string; quantity: number; unitPrice: number;
  lineSubtotal: number; lineDiscount: number; lineTax: number; lineTotal: number; metadata: unknown };
export interface ImportedOrderEditCharge {
  sourceId: string; listPrice: number; listPriceIncludesTax: boolean; taxRateBps: number;
  adjustments: number[]; net: number; gross: number; tax: number;
}
export interface ImportedOrderEditBasis {
  kind: 'imported-source'; lines: StackLine[]; pricesIncludeTax: boolean; sourceFingerprint: string; sourceDigest: string;
  shippingLines: Array<ImportedOrderEditCharge & { shippingMethodId: string | null; methodCode: string | null; orderLineIds: string[] }>;
  surcharges: Array<ImportedOrderEditCharge & { description: string }>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function rawObject(text: unknown, label: string) {
  requireFact(typeof text === 'string' && text.length > 0, `Missing retained ${label}`);
  const value: unknown = JSON.parse(text); requireFact(object(value), `Invalid retained ${label}`); return value;
}
/** PostgreSQL JSON integers can exceed Number's precision; retain header tokens. */
function rawHeaderLexeme(record: string, field: string): string | undefined {
  let position = record.indexOf('{') + 1;
  const whitespace = () => { while (/\s/.test(record[position] ?? '') && position < record.length) position++; };
  const stringEnd = (start: number) => { let end = start + 1; for (; end < record.length; end++) { if (record[end] === '\\') end++; else if (record[end] === '"') return end + 1; } return end; };
  while (position < record.length) {
    whitespace(); if (record[position] === '}') return undefined;
    requireFact(record[position] === '"', 'Invalid retained header key');
    const end = stringEnd(position), key = JSON.parse(record.slice(position, end)); position = end; whitespace();
    requireFact(record[position++] === ':', 'Invalid retained header separator'); whitespace();
    const start = position; let depth = 0;
    for (; position < record.length; position++) {
      const char = record[position];
      if (char === '"') { position = stringEnd(position) - 1; continue; }
      if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') { if (depth === 0) break; depth--; }
      else if (char === ',' && depth === 0) break;
    }
    if (key === field) return record.slice(start, position).trim();
    if (record[position] === '}') return undefined;
    requireFact(record[position++] === ',', 'Invalid retained header boundary');
  }
  return undefined;
}
function sourceId(value: unknown): string {
  requireFact((typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0), 'Invalid retained source identity');
  return String(value);
}
function rawInteger(value: unknown, label: string, signed = false): number {
  requireFact(typeof value === 'number' || (typeof value === 'string' && /^-?[0-9]+$/.test(value)), `Invalid retained ${label}`);
  const n = Number(value); money(n, label, signed); return n;
}
/** Validates raw getter parity without inventing historical promotion facts. */
function importedComponents(metadata: unknown, context: { currency: string; couponCodes?: readonly string[] }) {
  requireFact(object(metadata) && object(metadata.vendure), 'Missing imported source identity');
  const source = metadata.vendure; const raw = source.editBasisV1;
  requireFact(object(raw) && raw.version === 1 && raw.format === 'retained-pg-jsonb-text-v1' && typeof source.sourceKey === 'string' && raw.sourceKey === source.sourceKey &&
    sourceId(raw.sourceOrderId) === sourceId(source.id) && typeof raw.sourceDigest === 'string', 'Missing retained imported edit basis');
  const { sourceDigest, ...payload } = raw;
  requireFact(sourceDigest === orderEditStoredFingerprint(payload), 'Retained source digest differs');
  const order = rawObject(raw.sourceOrderRecord, 'order');
  requireFact(sourceId(order.id) === raw.sourceOrderId && order.currencyCode === context.currency, 'Retained order identity/currency differs');
  requireFact(object(raw.channel) && raw.channel.projection === 'pricing-v1', 'Missing retained selected channel pricing');
  const channel = rawObject(raw.channel.sourceRecord, 'channel pricing'), membership = rawObject(raw.channel.orderChannelRecord, 'selected channel relation');
  requireFact(sourceId(raw.channel.sourceId) === sourceId(channel.id) && sourceId(membership.channelId) === sourceId(channel.id) &&
    sourceId(membership.orderId) === raw.sourceOrderId && typeof channel.pricesIncludeTax === 'boolean' && channel.defaultCurrencyCode === context.currency &&
    Object.keys(channel).length === 4 && ['id', 'defaultCurrencyCode', 'pricesIncludeTax', 'defaultTaxZoneId'].every(key => Object.hasOwn(channel, key)), 'Retained selected channel pricing/ownership differs');
  requireFact(object(raw.header), 'Missing source header');
  for (const key of ['subTotal', 'subTotalWithTax', 'shipping', 'shippingWithTax']) {
    const value = raw.header[key], token = rawHeaderLexeme(String(raw.sourceOrderRecord), key);
    requireFact(value === null || typeof value === 'string' && /^-?[0-9]+$/.test(value), 'Invalid source header lexeme');
    requireFact(value === null ? token === 'null' : token !== undefined && /^-?[0-9]+$/.test(token) && BigInt(value) === BigInt(token), 'Retained header differs from source record');
  }
  if (context.couponCodes !== undefined) {
    requireFact(Array.isArray(order.couponCodes) && order.couponCodes.every(code => typeof code === 'string'), 'Missing complete source coupon array');
    requireFact(JSON.stringify(canonicalCouponCodes(order.couponCodes as string[])) === JSON.stringify(canonicalCouponCodes(context.couponCodes)), 'Retained coupon membership differs');
  }
  requireFact(Array.isArray(raw.lines) && Array.isArray(raw.shippingLines) && Array.isArray(raw.surcharges) && Array.isArray(raw.shippingMethods), 'Imported source child closure differs');
  const methods = new Map<string, Record<string, unknown>>();
  for (const entry of raw.shippingMethods) {
    requireFact(object(entry), 'Invalid retained shipping method'); const record = rawObject(entry.sourceRecord, 'shipping method'), id = sourceId(entry.sourceId);
    requireFact(id === sourceId(record.id) && !methods.has(id) && typeof record.code === 'string' && record.code.length > 0, 'Retained shipping method identity differs'); methods.set(id, record);
  }
  const charge = (record: Record<string, unknown>, id: string, shipping: boolean): ImportedOrderEditCharge => {
    const listPrice = rawInteger(record.listPrice, 'source charge list price', true);
    requireFact(typeof record.listPriceIncludesTax === 'boolean' && Array.isArray(record.taxLines) && (!shipping || Array.isArray(record.adjustments)), 'Missing retained source charge price/tax facts');
    const taxRateBps = record.taxLines.reduce<number>((sum, tax) => { requireFact(object(tax) && (typeof tax.taxRate === 'number' || typeof tax.taxRate === 'string'), 'Invalid source charge tax');
      const rate = Number(tax.taxRate); requireFact(Number.isFinite(rate) && rate >= 0, 'Invalid source charge tax rate'); return sum + rate * 100; }, 0);
    money(taxRateBps, 'source charge tax rate');
    const adjustments = shipping ? (record.adjustments as unknown[]).map(adjustment => { requireFact(object(adjustment), 'Invalid source shipping adjustment'); return rawInteger(adjustment.amount, 'source shipping adjustment', true); }) : [];
    const adjusted = listPrice + adjustments.reduce((sum, amount) => sum + amount, 0); money(adjusted, 'source discounted charge', true);
    const factor = 1 + taxRateBps / 10000, net = Math.round(record.listPriceIncludesTax ? adjusted / factor : adjusted), gross = Math.round(record.listPriceIncludesTax ? adjusted : adjusted * factor);
    money(net, 'source charge net', true); money(gross, 'source charge gross', true); money(gross - net, 'source charge tax', true);
    return { sourceId: id, listPrice, listPriceIncludesTax: record.listPriceIncludesTax, taxRateBps, adjustments, net, gross, tax: gross - net };
  };
  const shippingLines: ImportedOrderEditBasis['shippingLines'] = [], surcharges: ImportedOrderEditBasis['surcharges'] = [], usedMethods = new Set<string>();
  const shippingIds = new Set<string>();
  for (const entry of [...raw.shippingLines, ...raw.surcharges]) {
    requireFact(object(entry), 'Invalid source child'); const record = rawObject(entry.sourceRecord, 'child');
    requireFact(sourceId(entry.sourceId) === sourceId(record.id) && sourceId(record.orderId) === raw.sourceOrderId, 'Source child ownership differs');
    if (raw.shippingLines.includes(entry)) {
      const id = sourceId(entry.sourceId), methodId = record.shippingMethodId == null ? null : sourceId(record.shippingMethodId), method = methodId ? methods.get(methodId) : undefined;
      requireFact(!shippingIds.has(id) && (methodId === null || method), 'Source shipping line/method closure differs'); shippingIds.add(id); if (methodId) usedMethods.add(methodId);
      shippingLines.push({ ...charge(record, id, true), shippingMethodId: methodId, methodCode: method ? String(method.code) : null, orderLineIds: [] });
    } else {
      const id = sourceId(entry.sourceId); requireFact(!surcharges.some(item => item.sourceId === id) && typeof record.description === 'string', 'Source surcharge closure differs');
      surcharges.push({ ...charge(record, id, false), description: record.description });
    }
  }
  requireFact(usedMethods.size === methods.size, 'Source shipping method set differs');
  const lineIds = new Set<string>(), sourceLineIds = new Set<string>();
  for (const entry of raw.lines) {
    requireFact(object(entry) && typeof entry.orderLineId === 'string' && !lineIds.has(entry.orderLineId), 'Invalid source shipping membership');
    const record = rawObject(entry.sourceRecord, 'shipping member line'), id = sourceId(entry.sourceId);
    requireFact(id === sourceId(record.id) && sourceId(record.orderId) === raw.sourceOrderId && !sourceLineIds.has(id), 'Source shipping member ownership differs');
    lineIds.add(entry.orderLineId); sourceLineIds.add(id);
    if (record.shippingLineId != null) {
      const carrier = shippingLines.find(line => line.sourceId === sourceId(record.shippingLineId));
      requireFact(carrier, 'Source line shipping relation differs'); carrier.orderLineIds.push(entry.orderLineId);
    }
  }
  return { raw, sourceDigest: String(sourceDigest), pricesIncludeTax: channel.pricesIncludeTax, shippingLines, surcharges, shippingIds };
}
/** Immutable raw charge proof remains valid after merchandise quantities change. */
export function readImportedOrderEditComponents(metadata: unknown, currency: string) {
  const { sourceDigest, pricesIncludeTax, shippingLines, surcharges } = importedComponents(metadata, { currency });
  return { sourceDigest, pricesIncludeTax, shippingLines, surcharges };
}
export function readImportedOrderEditBasis(metadata: unknown, context: { storeId: string; orderId: string; currency: string;
  orderLines: readonly ImportedNativeLine[]; couponCodes?: readonly string[] }): ImportedOrderEditBasis {
  const { raw, sourceDigest, pricesIncludeTax, shippingLines, surcharges, shippingIds } = importedComponents(metadata, context);
  requireFact(context.orderId === migrationId(context.storeId, String(raw.sourceKey), 'order', raw.sourceOrderId), 'Native/source order identity differs');
  requireFact(Array.isArray(raw.lines) && raw.lines.length === context.orderLines.length, 'Imported source child closure differs');
  const ids = new Set<string>(); const sourceIds = new Set<string>();
  const lines = raw.lines.map((entry): StackLine => {
    requireFact(object(entry) && typeof entry.orderLineId === 'string' && !ids.has(entry.orderLineId), 'Invalid retained native line mapping'); ids.add(entry.orderLineId);
    const line = context.orderLines.find(line => line.id === entry.orderLineId);
    const record = rawObject(entry.sourceRecord, 'line'); const id = sourceId(entry.sourceId);
    requireFact(!sourceIds.has(id) && id === sourceId(record.id) && sourceId(record.orderId) === raw.sourceOrderId && line && line.orderId === context.orderId && line.storeId === context.storeId &&
      line.id === migrationId(context.storeId, String(raw.sourceKey), 'order-line', id), 'Source line ownership differs'); sourceIds.add(id);
    requireFact(object(line.metadata) && object(line.metadata.vendure) && sourceId(line.metadata.vendure.id) === id, 'Native/source line identity differs');
    if (record.shippingLineId != null) requireFact(shippingIds.has(sourceId(record.shippingLineId)), 'Source line shipping relation differs');
    const quantity = rawInteger(record.quantity, 'quantity'); const placedQuantity = record.orderPlacedQuantity == null ? quantity : rawInteger(record.orderPlacedQuantity, 'placed quantity');
    const listPrice = rawInteger(record.listPrice, 'list price');
    requireFact(typeof record.listPriceIncludesTax === 'boolean' && Array.isArray(record.adjustments) && Array.isArray(record.taxLines), 'Missing retained raw line price facts');
    const adjustments = record.adjustments.map(adjustment => { requireFact(object(adjustment), 'Invalid retained adjustment'); return { amount: rawInteger(adjustment.amount, 'adjustment', true), type: adjustment.type }; });
    const taxLines = record.taxLines.map(tax => { requireFact(object(tax) && (typeof tax.taxRate === 'number' || typeof tax.taxRate === 'string'), 'Invalid retained tax line');
      const rate = Number(tax.taxRate); requireFact(Number.isFinite(rate) && rate >= 0, 'Invalid retained tax rate'); return { taxRate: rate }; });
    const taxRateBps = taxLines.reduce((total, tax) => total + tax.taxRate * 100, 0); money(taxRateBps, 'retained tax rate');
    const input: VendureLineSnapshotInput = { quantity, orderPlacedQuantity: placedQuantity, listPrice, listPriceIncludesTax: record.listPriceIncludesTax, adjustments, taxLines };
    const projection = vendureLineMoney(input);
    requireFact(line.quantity === quantity && Object.entries(projection).every(([key, amount]) => line[key as keyof typeof projection] === amount), 'Retained source getter/native financial parity differs');
    return { key: line.id, quantity, placedQuantity: Math.max(quantity, placedQuantity), unitListPrice: listPrice,
      priceIncludesTax: record.listPriceIncludesTax, taxRateBps, priorAdjustments: [] };
  });
  return { kind: 'imported-source', lines, pricesIncludeTax, sourceDigest, shippingLines, surcharges,
    sourceFingerprint: orderEditStoredFingerprint({ metadata, lines: context.orderLines }) };
}
