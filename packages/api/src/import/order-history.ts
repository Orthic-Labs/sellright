import { eq } from 'drizzle-orm';
import * as s from '../db/schema.js';
import type { ImportContext, ManifestExclusion } from './context.js';
import { digest } from './artifacts.js';

export interface SourceModification {
  id: string; sourceRecord: string; sourceOrderId: string | null;
  sourcePaymentId: string | null; sourceRefundId: string | null;
  sourceCreatedAt: string | null; sourceUpdatedAt: string | null;
  priceChange: number; note: string;
  shippingAddressChange: string | null; billingAddressChange: string | null;
}
export interface SourceModificationReference {
  id: string; modificationId: string | null; orderLineId: string;
  discriminator: string; sourceRecord: string;
}
export interface SourceHistoryGraph {
  orders: ReadonlyMap<string, { selected: boolean; hasChannel: boolean }>;
  lines: ReadonlyMap<string, string | null>;
  payments: ReadonlyMap<string, string | null>;
  refunds: ReadonlyMap<string, string | null>;
}
export interface TargetHistoryGraph {
  orders: ReadonlyMap<string, { id: string; storeId: string }>;
  payments: ReadonlyMap<string, { id: string; storeId: string; orderId: string }>;
  refunds: ReadonlyMap<string, { id: string; storeId: string; orderId: string; paymentId: string }>;
}

/** All identity evidence must agree. A missing edge never grants ownership. */
export function classifyModification(row: SourceModification, refs: readonly SourceModificationReference[], graph: SourceHistoryGraph) {
  const candidates: string[] = [];
  let unresolved = false;
  let contradictoryFinancialLinks = false;
  const add = (id: string | null | undefined) => { if (id == null || !graph.orders.has(id)) unresolved = true; else candidates.push(id); };
  if (row.sourceOrderId != null) add(row.sourceOrderId);
  if (row.sourcePaymentId != null) add(graph.payments.get(row.sourcePaymentId));
  if (row.sourceRefundId != null) {
    const payment = graph.refunds.get(row.sourceRefundId);
    contradictoryFinancialLinks = row.sourcePaymentId != null && payment != null && row.sourcePaymentId !== payment;
    add(payment == null ? null : graph.payments.get(payment));
  }
  for (const ref of refs) {
    if (ref.discriminator !== 'OrderModificationLine') unresolved = true;
    add(graph.lines.get(ref.orderLineId));
  }
  const identities = new Set(candidates);
  const contradictory = identities.size > 1 || contradictoryFinancialLinks;
  const orderId = identities.size === 1 ? candidates[0]! : null;
  const order = orderId == null ? undefined : graph.orders.get(orderId);
  const scopeDisposition = unresolved || contradictory || !order?.hasChannel ? 'unresolved_parent' as const
    : order.selected ? 'selected_channel' as const : 'other_channel' as const;
  return { scopeDisposition, sourceOrderId: orderId, contradictory };
}

/** Pure assembly keeps opaque PostgreSQL JSON text outside JavaScript JSON parsing. */
export function buildImportedOrderHistory(input: {
  storeId: string; sourceKey: string; id: ImportContext['id'];
  modifications: readonly SourceModification[]; references: readonly SourceModificationReference[];
  source: SourceHistoryGraph; target: TargetHistoryGraph;
}): { rows: Array<typeof s.importedOrderModification.$inferInsert>; exclusions: ManifestExclusion[] } {
  const { storeId, sourceKey, source, target } = input;
  const parents = new Set(input.modifications.map(row => row.id));
  if (input.references.some(ref => ref.modificationId == null || !parents.has(ref.modificationId))) throw new Error('Order modification reference has no retained parent');
  const exclusions: ManifestExclusion[] = [];
  const rows = input.modifications.map(row => {
    const refs = input.references.filter(ref => ref.modificationId === row.id).sort((a, b) => {
      const left = BigInt(a.id), right = BigInt(b.id);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const scope = classifyModification(row, refs, source);
    const sourceReferences = refs.map(ref => ref.sourceRecord);
    if (!Number.isInteger(row.priceChange) || row.priceChange < -2147483648 || row.priceChange > 2147483647 || typeof row.note !== 'string' || typeof row.sourceRecord !== 'string' || sourceReferences.some(ref => typeof ref !== 'string')) {
      throw new Error('Invalid source modification transport');
    }
    const order = scope.scopeDisposition === 'selected_channel' && scope.sourceOrderId != null
      ? target.orders.get(input.id('order', scope.sourceOrderId)) : undefined;
    if (order && order.storeId !== storeId) throw new Error('Cross-store modification order link refused');
    const payment = order && row.sourcePaymentId != null ? target.payments.get(input.id('payment', row.sourcePaymentId)) : undefined;
    const refund = order && row.sourceRefundId != null ? target.refunds.get(input.id('refund', row.sourceRefundId)) : undefined;
    if ((payment && (payment.storeId !== storeId || payment.orderId !== order!.id)) ||
        (refund && (refund.storeId !== storeId || refund.orderId !== order!.id ||
          (payment && refund.paymentId !== payment.id)))) throw new Error('Inconsistent modification financial link refused');
    if (scope.scopeDisposition !== 'selected_channel') exclusions.push({ type: 'unmappable-source-row', table: 'order_modification', count: 1,
      blocking: scope.scopeDisposition === 'unresolved_parent',
      detail: scope.contradictory ? 'Retained source modification has contradictory parent orders; semantic projection blocked'
        : scope.scopeDisposition === 'other_channel' ? 'Retained source modification belongs to another channel; unattached'
          : 'Retained source modification has unresolved parent ownership; semantic projection blocked' });
    return {
      id: input.id('order-modification', row.id), storeId, sourceKey, sourceId: row.id,
      sourceRecord: row.sourceRecord, sourceReferences,
      sourceDigest: digest({ format: 'retained-pg-jsonb-text-v1', modification: row.sourceRecord, references: sourceReferences }),
      sourceOrderId: row.sourceOrderId, sourcePaymentId: row.sourcePaymentId, sourceRefundId: row.sourceRefundId,
      orderId: order?.id ?? null, paymentId: payment?.id ?? null, refundId: refund?.id ?? null,
      scopeDisposition: scope.scopeDisposition, sourceCreatedAt: row.sourceCreatedAt, sourceUpdatedAt: row.sourceUpdatedAt,
      priceChange: row.priceChange, note: row.note, shippingAddressChange: row.shippingAddressChange, billingAddressChange: row.billingAddressChange,
    };
  });
  return { rows, exclusions };
}

/** Retain history only, after operational orders, payments & refunds are mapped. */
export async function importOrderHistory(ctx: ImportContext): Promise<void> {
  if (!ctx.sourceColumns.has('order_modification')) {
    ctx.exclusions.push({ type: 'source-extension-absent', table: 'order_modification', detail: 'Source vintage has no order modification table' });
    return;
  }
  const modifications = await ctx.q(`SELECT m.id::text AS id, to_jsonb(m)::text AS "sourceRecord",
    m."orderId"::text AS "sourceOrderId", m."paymentId"::text AS "sourcePaymentId", m."refundId"::text AS "sourceRefundId",
    m."createdAt"::text AS "sourceCreatedAt", m."updatedAt"::text AS "sourceUpdatedAt", m."priceChange", m.note,
    m."shippingAddressChange", m."billingAddressChange" FROM order_modification m ORDER BY m.id`) as SourceModification[];
  const references = await ctx.q(`SELECT r.id::text AS id, r."modificationId"::text AS "modificationId",
    r."orderLineId"::text AS "orderLineId", r.discriminator, to_jsonb(r)::text AS "sourceRecord"
    FROM order_line_reference r WHERE r."modificationId" IS NOT NULL OR r.discriminator='OrderModificationLine' ORDER BY r.id`) as SourceModificationReference[];
  const sourceOrders = await ctx.q(`SELECT o.id::text AS id,
    EXISTS(SELECT 1 FROM order_channels_channel c WHERE c."orderId"=o.id AND c."channelId"=$1) AS selected,
    EXISTS(SELECT 1 FROM order_channels_channel c WHERE c."orderId"=o.id) AS "hasChannel" FROM "order" o ORDER BY o.id`, [ctx.channelId]);
  const sourceLines = await ctx.q('SELECT id::text AS id, "orderId"::text AS "orderId" FROM order_line ORDER BY id');
  const sourcePayments = await ctx.q('SELECT id::text AS id, "orderId"::text AS "orderId" FROM payment ORDER BY id');
  const sourceRefunds = await ctx.q('SELECT id::text AS id, "paymentId"::text AS "paymentId" FROM refund ORDER BY id');
  // Explicit predicates protect import even when its database role bypasses RLS.
  const orders = await ctx.tx.select().from(s.order).where(eq(s.order.storeId, ctx.storeId));
  const payments = await ctx.tx.select().from(s.payment).where(eq(s.payment.storeId, ctx.storeId));
  const refunds = await ctx.tx.select().from(s.refund).where(eq(s.refund.storeId, ctx.storeId));
  const result = buildImportedOrderHistory({ storeId: ctx.storeId, sourceKey: ctx.sourceKey, id: ctx.id, modifications, references,
    source: { orders: new Map(sourceOrders.map(row => [row.id, { selected: row.selected, hasChannel: row.hasChannel }])),
      lines: new Map(sourceLines.map(row => [row.id, row.orderId])), payments: new Map(sourcePayments.map(row => [row.id, row.orderId])),
      refunds: new Map(sourceRefunds.map(row => [row.id, row.paymentId])) },
    target: { orders: new Map(orders.map(row => [row.id, row])), payments: new Map(payments.map(row => [row.id, row])), refunds: new Map(refunds.map(row => [row.id, row])) } });
  for (const row of result.rows) await ctx.tx.insert(s.importedOrderModification).values(row).onConflictDoUpdate({
    target: [s.importedOrderModification.storeId, s.importedOrderModification.sourceKey, s.importedOrderModification.sourceId], set: row,
  });
  ctx.exclusions.push(...result.exclusions);
}
