import { and, eq, sql } from 'drizzle-orm';
import * as s from '../db/schema.js';
import type { ImportContext } from './context.js';
import { vendureProratedUnitPriceWithTax, type VendureLineSnapshotInput } from './vendure-money.js';
import { parseDate } from './store.js';
import { digest } from './artifacts.js';

export interface EditBasisSourceOrder {
  id: string; selected: boolean; sourceRecord: string;
  subTotal: string | null; subTotalWithTax: string | null; shipping: string | null; shippingWithTax: string | null;
}
export interface EditBasisSourceChild { id: string; orderId: string; sourceRecord: string }
export interface EditBasisSourceLine extends EditBasisSourceChild { shippingLineId: string | null }
export interface EditBasisSourceShippingLine extends EditBasisSourceChild { shippingMethodId: string | null }
export interface EditBasisSourceRecord { id: string; sourceRecord: string }
export interface EditBasisSourceOrderChannel { orderId: string; channelId: string; sourceRecord: string }
interface EditBasisTargetOrder { id: string; storeId: string; metadata: unknown }
interface EditBasisTargetLine extends EditBasisTargetOrder { orderId: string }

/** Retained source facts only. LIST cannot be recovered from reconciled NET.
 * Every monetary lexeme & full PostgreSQL JSON record stays text, never parsed
 * through JavaScript numbers or reconstructed from operational line totals. */
export function buildImportedEditBasis(input: {
  storeId: string; sourceKey: string; id: ImportContext['id']; channelId: string; currency: string;
  orders: readonly EditBasisSourceOrder[]; lines: readonly EditBasisSourceLine[];
  shippingLines: readonly EditBasisSourceShippingLine[]; surcharges: readonly EditBasisSourceChild[];
  channels: readonly EditBasisSourceRecord[]; orderChannels: readonly EditBasisSourceOrderChannel[];
  shippingMethods: readonly EditBasisSourceRecord[];
  targetOrders: readonly EditBasisTargetOrder[]; targetLines: readonly EditBasisTargetLine[];
}) {
  const sourceId = (value: unknown): string => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
    throw new Error('Invalid edit basis source identity');
  };
  const indexed = <T extends { id: string }>(rows: readonly T[]) => {
    const map = new Map<string, T>();
    for (const row of rows) {
      const id = sourceId(row.id);
      if (map.has(id)) throw new Error('Duplicate edit basis source identity');
      map.set(id, row);
    }
    return map;
  };
  const orders = indexed(input.orders), lines = indexed(input.lines);
  const shippingLines = indexed(input.shippingLines), surcharges = indexed(input.surcharges);
  // Parse identities/flags only, quoting every JSON numeric token first. Raw
  // records remain unchanged; even bigint IDs & decimal custom fields never
  // pass through a JavaScript Number during capture validation.
  const record = (text: string): Record<string, unknown> => {
    if (typeof text !== 'string' || !text) throw new Error('Edit basis source record missing');
    const exact = text.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g,
      token => token.startsWith('"') ? token : JSON.stringify(token));
    const value: unknown = JSON.parse(exact);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid edit basis source record');
    return value as Record<string, unknown>;
  };
  const channelId = sourceId(input.channelId), channels = indexed(input.channels);
  const channel = channels.get(channelId);
  if (channels.size !== 1 || !channel) throw new Error('Edit basis selected channel missing/mismatched');
  const channelRecord = record(channel.sourceRecord);
  if (sourceId(channelRecord.id) !== channelId || typeof channelRecord.pricesIncludeTax !== 'boolean' ||
      channelRecord.defaultCurrencyCode !== input.currency || !Object.hasOwn(channelRecord, 'defaultTaxZoneId') ||
      Object.keys(channelRecord).sort().join(',') !== 'defaultCurrencyCode,defaultTaxZoneId,id,pricesIncludeTax') {
    throw new Error('Edit basis selected channel pricing projection mismatch');
  }
  if (channelRecord.defaultTaxZoneId !== null) sourceId(channelRecord.defaultTaxZoneId);
  const orderChannels = new Map<string, EditBasisSourceOrderChannel>();
  for (const row of input.orderChannels) {
    const orderId = sourceId(row.orderId), raw = record(row.sourceRecord);
    if (!orders.has(orderId) || sourceId(row.channelId) !== channelId || sourceId(raw.orderId) !== orderId ||
        sourceId(raw.channelId) !== channelId || orderChannels.has(orderId)) {
      throw new Error('Edit basis selected order/channel relation mismatch/duplicate');
    }
    orderChannels.set(orderId, row);
  }
  const shippingMethods = indexed(input.shippingMethods), referencedMethods = new Set<string>();
  for (const row of shippingMethods.values()) {
    if (sourceId(record(row.sourceRecord).id) !== row.id) throw new Error('Edit basis shipping method identity mismatch');
  }
  const orderTargets = new Map<string, EditBasisTargetOrder>();
  for (const row of input.targetOrders) {
    const vendure = (row.metadata as { vendure?: { id?: unknown; sourceKey?: unknown } } | null)?.vendure;
    const id = sourceId(vendure?.id);
    if (row.storeId !== input.storeId || vendure?.sourceKey !== input.sourceKey || row.id !== input.id('order', id) || orderTargets.has(id)) {
      throw new Error('Edit basis target source/tenant identity mismatch');
    }
    const source = orders.get(id);
    if (!source || source.selected !== true) throw new Error('Edit basis source order ownership missing');
    orderTargets.set(id, row);
  }
  if (orders.size !== orderTargets.size) throw new Error('Edit basis source order set differs from target');
  if (orderChannels.size !== orders.size) throw new Error('Edit basis selected order/channel relation missing');
  const lineTargets = new Map<string, EditBasisTargetLine>();
  for (const row of input.targetLines) {
    const vendure = (row.metadata as { vendure?: { id?: unknown } } | null)?.vendure;
    const id = sourceId(vendure?.id), source = lines.get(id);
    const parent = source && orderTargets.get(source.orderId);
    if (row.storeId !== input.storeId || row.id !== input.id('order-line', id) || !parent || row.orderId !== parent.id || lineTargets.has(id)) {
      throw new Error('Edit basis line source/tenant ownership mismatch');
    }
    lineTargets.set(id, row);
  }
  if (lines.size !== lineTargets.size) throw new Error('Edit basis source line set differs from target');
  for (const row of [...lines.values(), ...shippingLines.values(), ...surcharges.values()]) {
    if (!orderTargets.has(sourceId(row.orderId)) || typeof row.sourceRecord !== 'string' || !row.sourceRecord) {
      throw new Error('Edit basis source child ownership/record missing');
    }
    const raw = record(row.sourceRecord);
    if (sourceId(raw.id) !== row.id || sourceId(raw.orderId) !== row.orderId) {
      throw new Error('Edit basis source child identity/ownership mismatch');
    }
  }
  for (const line of lines.values()) {
    const rawShippingLineId = record(line.sourceRecord).shippingLineId;
    if (rawShippingLineId === null ? line.shippingLineId !== null : sourceId(rawShippingLineId) !== sourceId(line.shippingLineId)) {
      throw new Error('Edit basis line shipping ownership mismatch');
    }
    if (line.shippingLineId == null) continue;
    const shippingLine = shippingLines.get(sourceId(line.shippingLineId));
    if (!shippingLine || shippingLine.orderId !== line.orderId) throw new Error('Edit basis line shipping ownership mismatch');
  }
  for (const row of shippingLines.values()) {
    const raw = record(row.sourceRecord);
    if (sourceId(raw.id) !== row.id || sourceId(raw.orderId) !== row.orderId ||
        (raw.shippingMethodId === null ? row.shippingMethodId !== null : sourceId(raw.shippingMethodId) !== sourceId(row.shippingMethodId))) {
      throw new Error('Edit basis shipping source relation mismatch');
    }
    if (row.shippingMethodId === null) continue;
    const methodId = sourceId(row.shippingMethodId);
    if (!shippingMethods.has(methodId)) throw new Error('Edit basis referenced shipping method missing');
    referencedMethods.add(methodId);
  }
  if (referencedMethods.size !== shippingMethods.size) throw new Error('Edit basis unrelated shipping method');
  const sorted = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
  const byOrder = <T extends EditBasisSourceChild>(rows: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) { const group = map.get(row.orderId) ?? []; group.push(row); map.set(row.orderId, group); }
    return map;
  };
  const shippingByOrder = byOrder(input.shippingLines), surchargesByOrder = byOrder(input.surcharges), linesByOrder = byOrder(input.lines);
  const records = (rows: readonly EditBasisSourceChild[]) => sorted(rows)
    .map(row => ({ sourceId: row.id, sourceRecord: row.sourceRecord }));
  return input.targetOrders.map(target => {
    const sourceOrderId = sourceId((target.metadata as { vendure: { id: unknown } }).vendure.id);
    const order = orders.get(sourceOrderId)!;
    const header = { subTotal: order.subTotal, subTotalWithTax: order.subTotalWithTax,
      shipping: order.shipping, shippingWithTax: order.shippingWithTax };
    if (typeof order.sourceRecord !== 'string' || !order.sourceRecord || Object.values(header).some(value => value !== null && typeof value !== 'string')) {
      throw new Error('Invalid edit basis source header transport');
    }
    if (sourceId(record(order.sourceRecord).id) !== sourceOrderId) throw new Error('Edit basis source order identity mismatch');
    const payload = { version: 1 as const, format: 'retained-pg-jsonb-text-v1' as const,
      sourceKey: input.sourceKey, sourceOrderId, sourceOrderRecord: order.sourceRecord, header,
      channel: { sourceId: channelId, projection: 'pricing-v1' as const, sourceRecord: channel.sourceRecord,
        orderChannelRecord: orderChannels.get(sourceOrderId)!.sourceRecord },
      shippingMethods: sorted([...new Set((shippingByOrder.get(sourceOrderId) ?? [])
        .flatMap(row => row.shippingMethodId === null ? [] : [row.shippingMethodId]))].map(id => shippingMethods.get(id)!))
        .map(row => ({ sourceId: row.id, sourceRecord: row.sourceRecord })),
      shippingLines: records(shippingByOrder.get(sourceOrderId) ?? []), surcharges: records(surchargesByOrder.get(sourceOrderId) ?? []),
      lines: sorted(linesByOrder.get(sourceOrderId) ?? []).map(line => ({ sourceId: line.id,
        orderLineId: lineTargets.get(line.id)!.id, sourceRecord: line.sourceRecord })) };
    return { orderId: target.id, editBasisV1: { ...payload, sourceDigest: digest(payload) } };
  });
}

export type ImportedEditBasisV1 = ReturnType<typeof buildImportedEditBasis>[number]['editBasisV1'];

/** Uses the same ctx.q read-only repeatable-read transaction as all import
 * phases. Queries participate in reviewed global source digest as well. */
async function captureImportedEditBasis(ctx: ImportContext, targetLines: readonly EditBasisTargetLine[]) {
  const identity = await ctx.q(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only`);
  if (identity.length !== 1 || identity[0]!.isolation !== 'repeatable read' || identity[0]!.read_only !== 'on') {
    throw new Error('Edit basis requires source read-only repeatable-read snapshot');
  }
  const targetOrders = await ctx.tx.select().from(s.order).where(eq(s.order.storeId, ctx.storeId));
  // Source-read digests bind parameter order, independent of target scan order.
  const ids = targetOrders.map(order => {
    const vendure = (order.metadata as { vendure?: { id?: unknown; sourceKey?: unknown } } | null)?.vendure;
    if (vendure?.sourceKey !== ctx.sourceKey || vendure.id == null) throw new Error('Edit basis target source identity missing');
    return String(vendure.id);
  }).sort();
  const channels = await ctx.q(`SELECT c.id::text AS id, jsonb_build_object('id',c.id,
    'defaultCurrencyCode',c."defaultCurrencyCode",'pricesIncludeTax',c."pricesIncludeTax",
    'defaultTaxZoneId',c."defaultTaxZoneId")::text AS "sourceRecord"
    FROM channel c WHERE c.id=$1 ORDER BY c.id`, [ctx.channelId]) as EditBasisSourceRecord[];
  const orderChannels = await ctx.q(`SELECT c."orderId"::text AS "orderId", c."channelId"::text AS "channelId",
    to_jsonb(c)::text AS "sourceRecord" FROM order_channels_channel c
    WHERE c."orderId"::text=ANY($1::text[]) AND c."channelId"=$2 ORDER BY c."orderId", c."channelId"`, [ids, ctx.channelId]) as EditBasisSourceOrderChannel[];
  const orders = await ctx.q(`SELECT o.id::text AS id, to_jsonb(o)::text AS "sourceRecord",
    o."subTotal"::text AS "subTotal", o."subTotalWithTax"::text AS "subTotalWithTax",
    o.shipping::text AS shipping, o."shippingWithTax"::text AS "shippingWithTax",
    EXISTS(SELECT 1 FROM order_channels_channel c WHERE c."orderId"=o.id AND c."channelId"=$2) AS selected
    FROM "order" o WHERE o.id::text=ANY($1::text[]) ORDER BY o.id`, [ids, ctx.channelId]) as EditBasisSourceOrder[];
  const lines = await ctx.q(`SELECT l.id::text AS id, l."orderId"::text AS "orderId",
    l."shippingLineId"::text AS "shippingLineId", to_jsonb(l)::text AS "sourceRecord"
    FROM order_line l WHERE l."orderId"::text=ANY($1::text[]) ORDER BY l.id`, [ids]) as EditBasisSourceLine[];
  const shippingLines = await ctx.q(`SELECT l.id::text AS id, l."orderId"::text AS "orderId",
    l."shippingMethodId"::text AS "shippingMethodId", to_jsonb(l)::text AS "sourceRecord"
    FROM shipping_line l WHERE l."orderId"::text=ANY($1::text[]) ORDER BY l.id`, [ids]) as EditBasisSourceShippingLine[];
  // No deletedAt filter: historical lines can reference deleted methods.
  const shippingMethods = await ctx.q(`SELECT m.id::text AS id, to_jsonb(m)::text AS "sourceRecord"
    FROM shipping_method m WHERE m.id IN (SELECT l."shippingMethodId" FROM shipping_line l
      WHERE l."orderId"::text=ANY($1::text[]) AND l."shippingMethodId" IS NOT NULL) ORDER BY m.id`, [ids]) as EditBasisSourceRecord[];
  const surcharges = await ctx.q(`SELECT c.id::text AS id, c."orderId"::text AS "orderId", to_jsonb(c)::text AS "sourceRecord"
    FROM surcharge c WHERE c."orderId"::text=ANY($1::text[]) ORDER BY c.id`, [ids]) as EditBasisSourceChild[];
  const captures = buildImportedEditBasis({ storeId: ctx.storeId, sourceKey: ctx.sourceKey, id: ctx.id,
    channelId: String(ctx.channelId), currency: ctx.currency, channels, orderChannels, shippingMethods,
    orders, lines, shippingLines, surcharges, targetOrders, targetLines });
  const targetsById = new Map(targetOrders.map(order => [order.id, order]));
  for (const capture of captures) {
    const order = targetsById.get(capture.orderId)!;
    const metadata = order.metadata as Record<string, unknown> & { vendure: Record<string, unknown> };
    await ctx.tx.update(s.order).set({ metadata: { ...metadata, vendure: { ...metadata.vendure, editBasisV1: capture.editBasisV1 } } })
      .where(and(eq(s.order.storeId, ctx.storeId), eq(s.order.id, order.id)));
  }
}

/** Source refund references have quantities, not amounts. Allocate the exact
 * source items total proportionally with deterministic largest remainders. */
export function allocateRefundItems(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || weights.some(w => !Number.isFinite(w) || w < 0)) {
    throw new Error('Invalid refund allocation');
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) { if (total) throw new Error('Refund items have no lines'); return []; }
  if (!sum) { if (total) throw new Error('Refund items have no monetary basis'); return weights.map(() => 0); }
  const raw = weights.map(w => total * w / sum);
  const amounts = raw.map(Math.floor);
  const order = raw.map((n, i) => ({ i, remainder: n - amounts[i]! }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  let remaining = total - amounts.reduce((a, b) => a + b, 0);
  for (const row of order) { if (!remaining) break; amounts[row.i]!++; remaining--; }
  return amounts;
}

/** Source cash-refund basis rounds each eligible unit before quantity multiplication. */
export function refundLineWeight(snapshot: VendureLineSnapshotInput, quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Invalid refund quantity');
  return snapshot.orderPlacedQuantity > 0 ? vendureProratedUnitPriceWithTax(snapshot) * quantity : 0;
}

/** Source order states that assert the goods left the warehouse. */
const SHIPPED_SOURCE_STATES: Record<string, 'Shipped' | 'Delivered'> = {
  PartiallyShipped: 'Shipped', Shipped: 'Shipped', PartiallyDelivered: 'Delivered', Delivered: 'Delivered',
};

/**
 * A source order can be Shipped/Delivered with no fulfillment documents at
 * all (history carried over from the source's own earlier platform). Without
 * a fulfillment row SellRight derives it as "unfulfilled", so years of
 * delivered orders would read as awaiting shipment to customers and flood the
 * admin's to-ship queue. Record one fulfillment per such order, in the
 * order's own source state, covering only the quantity no source document
 * already accounts for. Marked `synthetic` with the source state as its
 * provenance; no tracking code is invented.
 */
async function synthesizeSourceShipments(ctx: ImportContext, fulfilledByLine: Map<string, number>) {
  const { tx, storeId } = ctx;
  const orders = await tx.select({ id: s.order.id, placedAt: s.order.placedAt, metadata: s.order.metadata })
    .from(s.order).where(eq(s.order.storeId, storeId));
  const lines = await tx.select({ id: s.orderLine.id, orderId: s.orderLine.orderId, quantity: s.orderLine.quantity,
    cancelledQty: s.orderLine.cancelledQty }).from(s.orderLine).where(eq(s.orderLine.storeId, storeId));
  const linesByOrder = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = linesByOrder.get(line.orderId) ?? [];
    list.push(line); linesByOrder.set(line.orderId, list);
  }
  let synthesized = 0;
  for (const order of orders) {
    const vendure = (order.metadata as { vendure?: { id?: unknown; state?: unknown } } | null)?.vendure;
    const state = SHIPPED_SOURCE_STATES[String(vendure?.state)];
    if (!state || vendure?.id == null) continue;
    const open = (linesByOrder.get(order.id) ?? [])
      .map(line => ({ line, remaining: line.quantity - line.cancelledQty - (fulfilledByLine.get(line.id) ?? 0) }))
      .filter(entry => entry.remaining > 0);
    if (!open.length) continue;
    const fulfillmentId = ctx.id('fulfillment', 'source-state:' + String(vendure.id));
    await tx.insert(s.fulfillment).values({ id: fulfillmentId, storeId, orderId: order.id, state,
      trackingCode: null, carrier: null,
      metadata: { synthetic: true, vendureOrderId: vendure.id, sourceOrderState: vendure.state },
      createdAt: order.placedAt ?? undefined, updatedAt: order.placedAt ?? undefined });
    for (const { line, remaining } of open) {
      await tx.insert(s.fulfillmentLine).values({ id: ctx.id('fulfillment-line', 'source-state:' + line.id),
        storeId, fulfillmentId, orderLineId: line.id, quantity: remaining });
      const next = (fulfilledByLine.get(line.id) ?? 0) + remaining;
      fulfilledByLine.set(line.id, next);
      await tx.update(s.orderLine).set({ fulfilledQty: next }).where(eq(s.orderLine.id, line.id));
    }
    synthesized++;
  }
  if (synthesized) {
    ctx.exclusions.push({ type: 'unmappable-source-row', table: 'fulfillment', count: synthesized,
      detail: `${synthesized} Shipped/Delivered source orders had no fulfillment documents — one synthetic fulfillment each (metadata.synthetic, no tracking) records the source state` });
  }
}

export async function importHistory(ctx: ImportContext) {
  const { tx, q, storeId } = ctx;
  // Explicit store_id predicates: the migration role may bypass RLS, so the
  // tenant boundary must live in the query itself.
  const lines = new Map((await tx.select().from(s.orderLine).where(eq(s.orderLine.storeId, storeId))).map(line => [line.id, line]));
  await captureImportedEditBasis(ctx, [...lines.values()]);
  const payments = new Map((await tx.select().from(s.payment).where(eq(s.payment.storeId, storeId))).map(payment => [payment.id, payment]));
  const refs = await q('SELECT r.*, to_jsonb(r)::text AS source_record FROM order_line_reference r ORDER BY r.id');
  const fulfilledByLine = new Map<string, number>();
  const refundedByLine = new Map<string, number>();
  const overfulfilledLines = new Set<string>();
  const overrefundedLines = new Set<string>();
  const fulfillments = await q('SELECT * FROM fulfillment ORDER BY id');
  for (const fulfillment of fulfillments) {
    if (!['Pending', 'Created', 'Shipped', 'Delivered', 'Cancelled'].includes(fulfillment.state)) {
      throw new Error('Unsupported fulfillment state: ' + fulfillment.state);
    }
    // Vendure's initial 'Created' fulfillment state maps to SellRight 'Pending'.
    if (fulfillment.state === 'Created') fulfillment.state = 'Pending';
    const matches = refs.filter(ref => ref.discriminator === 'FulfillmentLine' && ref.fulfillmentId === fulfillment.id);
    const byOrder = new Map<string, typeof matches>();
    for (const ref of matches) {
      const line = lines.get(ctx.id('order-line', ref.orderLineId));
      if (!line) continue;
      const list = byOrder.get(line.orderId) ?? [];
      list.push(ref); byOrder.set(line.orderId, list);
    }
    for (const [orderId, members] of byOrder) {
      const id = ctx.id('fulfillment', fulfillment.id + ':' + orderId);
      await tx.insert(s.fulfillment).values({ id, storeId, orderId, state: fulfillment.state,
        trackingCode: fulfillment.trackingCode || null, carrier: null,
        metadata: { vendureId: fulfillment.id, method: fulfillment.method, handlerCode: fulfillment.handlerCode },
        createdAt: parseDate(fulfillment.createdAt) ?? undefined, updatedAt: parseDate(fulfillment.updatedAt) ?? undefined });
      for (const ref of members) {
        const orderLineId = ctx.id('order-line', ref.orderLineId);
        await tx.insert(s.fulfillmentLine).values({ id: ctx.id('fulfillment-line', ref.id),
          storeId, fulfillmentId: id, orderLineId, quantity: ref.quantity });
        if (['Pending', 'Shipped', 'Delivered'].includes(fulfillment.state)) {
          // DD has fulfillment docs (often never-shipped 'Created' rows) whose
          // refs exceed the ordered quantity. The fulfillment_line keeps the
          // document quantity; fulfilledQty clamps at the line maximum and the
          // excess is recorded — the counter must stay within the line.
          const line = lines.get(orderLineId)!;
          const cap = Math.max(line.quantity,
            Number((line.metadata as { vendure?: { placedQuantity?: number } } | null)?.vendure?.placedQuantity) || 0);
          const acc = fulfilledByLine.get(orderLineId) ?? 0;
          const next = Math.min(acc + ref.quantity, cap);
          if (acc + ref.quantity > cap && !overfulfilledLines.has(orderLineId)) {
            overfulfilledLines.add(orderLineId);
            ctx.exclusions.push({ type: 'unmappable-source-row', table: 'order_line',
              detail: `order_line ${ref.orderLineId}: fulfillment refs exceed ordered quantity — fulfilledQty clamped at line maximum, document quantities kept` });
          }
          fulfilledByLine.set(orderLineId, next);
          await tx.update(s.orderLine).set({ fulfilledQty: next }).where(eq(s.orderLine.id, orderLineId));
        }
      }
    }
  }
  await synthesizeSourceShipments(ctx, fulfilledByLine);
  // PostgreSQL text transport preserves timestamps & numeric lexemes before node-pg parsing.
  const sourceRefunds = await q('SELECT r.*, to_jsonb(r)::text AS source_record FROM refund r ORDER BY id');
  const sourceRefundIds = new Set(sourceRefunds.map(row => String(row.id)));
  for (const ref of refs) {
    if ((ref.discriminator === 'RefundLine' || ref.refundId != null) &&
        (ref.refundId == null || !sourceRefundIds.has(String(ref.refundId)))) throw new Error('Source reference names an unknown refund: ' + ref.id);
  }
  const archives = await tx.select().from(s.financialPaymentArchive).where(eq(s.financialPaymentArchive.storeId, storeId));
  const archiveSourceIds = new Set(archives.map(row => row.sourceId));
  for (const archive of archives) {
    const refundRows = sourceRefunds.filter(row => String(row.paymentId) === archive.sourceId);
    const refunds = refundRows.map(row => row.source_record as string);
    const refundIds = new Set(refundRows.map(row => String(row.id)));
    const references = refs.filter(row => row.refundId != null && refundIds.has(String(row.refundId)))
      .map(row => row.source_record as string);
    await tx.update(s.financialPaymentArchive).set({ sourceRefunds: refunds, sourceReferences: references,
      sourceDigest: digest({ format: 'retained-pg-jsonb-text-v1', payment: archive.sourceRecord, refunds, references }) })
      .where(and(eq(s.financialPaymentArchive.storeId, storeId), eq(s.financialPaymentArchive.id, archive.id)));
  }
  for (const refund of sourceRefunds) {
    const payment = payments.get(ctx.id('payment', refund.paymentId));
    if (!payment) {
      if (archiveSourceIds.has(String(refund.paymentId))) continue;
      throw new Error('Source refund references an unknown payment: ' + refund.id);
    }
    if (refs.some(ref => ref.refundId === refund.id && ref.discriminator !== 'RefundLine')) {
      throw new Error('Unsupported source refund reference: ' + refund.id);
    }
    const total = Number(refund.total), items = Number(refund.items), shipping = Number(refund.shipping), adjustment = Number(refund.adjustment);
    // DD records refunds as flat totals with zero components; the total is the
    // captured money and stays authoritative. Components are imported verbatim
    // (including operator-entered negative adjustments); only a non-zero set
    // that fails to sum is genuinely contradictory — total still wins, flagged.
    if (![total, items, shipping, adjustment].every(Number.isSafeInteger)) {
      throw new Error('Refund breakdown is not integer money: ' + refund.id);
    }
    if (items + shipping + adjustment !== total) {
      ctx.exclusions.push({ type: 'unmappable-source-row', table: 'refund',
        detail: items === 0 && shipping === 0 && adjustment === 0
          ? `refund ${refund.id}: total-only source record (no item/shipping/adjustment breakdown) — imported amount=${total}`
          : `refund ${refund.id}: components ${items}+${shipping}+${adjustment} ≠ total ${total} — total imported, components kept verbatim`,
        count: 1 });
    }
    const state = refund.state === 'Settled' ? 'Settled' : refund.state === 'Failed' ? 'Failed' : 'Pending';
    if (state === 'Pending') throw new Error('Resolve source pending refund before cutover: ' + refund.id);
    const id = ctx.id('refund', refund.id);
    await tx.insert(s.refund).values({ id, storeId, paymentId: payment.id, orderId: payment.orderId,
      amount: total, itemsAmount: items, shippingAmount: shipping, adjustmentAmount: adjustment,
      reason: refund.reason, state, providerRef: refund.transactionId || null,
      metadata: { vendureId: refund.id, sourceMetadata: refund.metadata, allocation: 'derived-largest-remainder-by-placed-line-value' },
      createdAt: parseDate(refund.createdAt) ?? undefined });
    const members = refs.filter(ref => ref.discriminator === 'RefundLine' && ref.refundId === refund.id);
    const weights = members.map(ref => {
      const line = lines.get(ctx.id('order-line', ref.orderLineId));
      if (!line || line.orderId !== payment.orderId || !Number.isSafeInteger(ref.quantity) || ref.quantity < 1) throw new Error('Invalid refund line: ' + ref.id);
      const snapshot = (line.metadata as { vendure: VendureLineSnapshotInput & { placedQuantity: number } }).vendure;
      // A refund ref claiming more than ever ordered is source drift (DD has
      // these). The refund document imports verbatim; refundedQty clamps at the
      // line maximum and the excess is recorded for review — never dies.
      if (ref.quantity > Math.max(snapshot.placedQuantity, line.quantity)) {
        ctx.exclusions.push({ type: 'unmappable-source-row', table: 'order_line',
          detail: `refund ref ${ref.id} (refund ${refund.id}) claims qty ${ref.quantity} > placed ${Math.max(snapshot.placedQuantity, line.quantity)} on order_line ${ref.orderLineId} — refundedQty clamps at line maximum` });
      }
      return refundLineWeight({ ...snapshot, quantity: line.quantity, orderPlacedQuantity: snapshot.placedQuantity }, ref.quantity);
    });
    const amounts = allocateRefundItems(items, weights);
    for (let i = 0; i < members.length; i++) {
      const ref = members[i]!, orderLineId = ctx.id('order-line', ref.orderLineId);
      await tx.insert(s.refundLine).values({ id: ctx.id('refund-line', ref.id), storeId,
        refundId: id, orderLineId, quantity: ref.quantity, amount: amounts[i]!, restock: false });
      if (state === 'Settled') {
        const line = lines.get(orderLineId)!;
        const cap = Math.max(line.quantity,
          Number((line.metadata as { vendure?: { placedQuantity?: number } } | null)?.vendure?.placedQuantity) || 0);
        const acc = refundedByLine.get(orderLineId) ?? 0;
        const next = Math.min(acc + ref.quantity, cap);
        if (acc + ref.quantity > cap && !overrefundedLines.has(orderLineId)) {
          overrefundedLines.add(orderLineId);
          ctx.exclusions.push({ type: 'unmappable-source-row', table: 'order_line',
            detail: `order_line ${ref.orderLineId}: refund refs exceed ordered quantity — refundedQty clamped at line maximum, document quantities kept` });
        }
        refundedByLine.set(orderLineId, next);
        await tx.update(s.orderLine).set({ refundedQty: next }).where(eq(s.orderLine.id, orderLineId));
      }
    }
  }
  const invalid = await tx.select({ id: s.orderLine.id }).from(s.orderLine)
    .where(sql`${s.orderLine.storeId} = ${storeId} AND (${s.orderLine.fulfilledQty} > greatest(${s.orderLine.quantity}, coalesce((${s.orderLine.metadata}->'vendure'->>'placedQuantity')::int, 0)) OR ${s.orderLine.refundedQty} > greatest(${s.orderLine.quantity}, coalesce((${s.orderLine.metadata}->'vendure'->>'placedQuantity')::int, 0)))`);
  if (invalid.length) throw new Error('Imported fulfillment/refund quantities exceed order lines');
  const orders = new Map((await tx.select().from(s.order).where(eq(s.order.storeId, storeId))).map(order => [order.id, order]));
  const promotions = new Set((await tx.select({ id: s.promotion.id }).from(s.promotion).where(eq(s.promotion.storeId, storeId))).map(row => row.id));
  for (const usage of await q('SELECT * FROM order_promotions_promotion ORDER BY "orderId", "promotionId"')) {
    const order = orders.get(ctx.id('order', usage.orderId)), promotionId = ctx.id('promotion', usage.promotionId);
    if (!order || order.state === 'Cancelled' || !order.placedAt || !promotions.has(promotionId)) continue;
    await tx.insert(s.promotionUsage).values({ id: ctx.id('promotion-usage', usage.orderId + ':' + usage.promotionId),
      storeId, promotionId, orderId: order.id, customerId: order.customerId, createdAt: order.createdAt });
    await tx.update(s.promotion).set({ usedCount: sql`${s.promotion.usedCount} + 1` }).where(eq(s.promotion.id, promotionId));
  }
  for (const order of orders.values()) {
    const refunds = await tx.select().from(s.refund).where(eq(s.refund.orderId, order.id));
    const refunded = refunds.filter(refund => refund.state === 'Settled').reduce((sum, refund) => sum + refund.amount, 0);
    const settled = [...payments.values()].filter(payment => payment.orderId === order.id && payment.state === 'Settled').reduce((sum, payment) => sum + payment.amount, 0);
    // DD has orders whose settled refunds exceed their settled payments (a
    // refund linked to the wrong/smaller payment, or offline settlement). The
    // documents are real history — import them and flag for operator review
    // rather than blocking the cutover on source bookkeeping.
    if (refunded > settled) ctx.exclusions.push({ type: 'unmappable-source-row', table: 'refund',
      detail: `order ${order.code}: settled refunds ${refunded} exceed settled payments ${settled} — imported as recorded, review required` });
    if (refunded > 0 && order.state !== 'Cancelled') await tx.update(s.order)
      .set({ state: refunded === settled ? 'Refunded' : 'PartiallyRefunded' }).where(eq(s.order.id, order.id));
  }
  // Source inventory already includes these historical operations. No stock
  // movements, payment calls, confirmation emails or webhooks run during import.
}
