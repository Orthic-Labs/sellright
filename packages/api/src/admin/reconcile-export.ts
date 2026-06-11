/**
 * SellRight→Vendure reconciliation exporter (Regime-B rollback).
 *
 * If WP7 (RH cutover) or any subsequent rollback puts the storefront back on
 * Vendure while the historical truth lives in SellRight, ops needs a single
 * CSV per store that contains every order in enough detail to recreate the
 * order + lines + payments + refunds in Vendure's import format. This file
 * owns that format — it's the contract between SellRight (truth) and the
 * rollback script (consumer). Streamed as text/csv to keep memory bounded.
 *
 * Usage (CLI): tsx src/admin/reconcile-export.ts <store-slug> [since] [until]
 *   since / until: ISO date (inclusive start, exclusive end). Default: all time.
 *
 * Usage (programmatic): streamReconcileCSV(storeId, since?, until?) writes to a
 *   WritableStream; row shape is documented inline below.
 */
import { createWriteStream } from 'node:fs';
import { and, asc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

export interface ReconcileRow {
  code: string;
  state: string;
  placedAt: string; // ISO
  currency: string;
  email: string | null;
  shippingName: string | null;
  shippingLine1: string | null;
  shippingCity: string | null;
  shippingCountry: string | null;
  shippingPostalCode: string | null;
  subtotal: number; // cents
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  lineCount: number; // 1 row per order; lines are in lines.csv
}

const csvCell = (v: unknown): string => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Stream a per-order CSV to a WritableStream (one row per order; lines are a separate file). */
export async function streamReconcileOrdersCSV(storeId: string, out: NodeJS.WritableStream, opts: { since?: Date; until?: Date } = {}): Promise<number> {
  const header = ['code', 'state', 'placedAt', 'currency', 'email', 'shippingName', 'shippingLine1', 'shippingCity', 'shippingCountry', 'shippingPostalCode', 'subtotal', 'discountTotal', 'shippingTotal', 'taxTotal', 'grandTotal', 'lineCount'];
  out.write(header.join(',') + '\n');
  let n = 0;
  await withStore(storeId, async (tx) => {
    const conds = [isNotNull(s.order.placedAt)] as ReturnType<typeof eq>[];
    if (opts.since) conds.push(gte(s.order.placedAt, opts.since) as never);
    if (opts.until) conds.push(lt(s.order.placedAt, opts.until) as never);
    const rows = await tx
      .select({
        code: s.order.code, state: s.order.state, placedAt: s.order.placedAt, currency: s.order.currency,
        email: s.customer.email,
        shipName: sql<string | null>`(${s.order.shippingAddress}->>'fullName')`,
        shipLine1: sql<string | null>`(${s.order.shippingAddress}->>'line1')`,
        shipCity: sql<string | null>`(${s.order.shippingAddress}->>'city')`,
        shipCountry: sql<string | null>`(${s.order.shippingAddress}->>'country')`,
        shipPostal: sql<string | null>`(${s.order.shippingAddress}->>'postalCode')`,
        subtotal: s.order.subtotal, discountTotal: s.order.discountTotal, shippingTotal: s.order.shippingTotal, taxTotal: s.order.taxTotal, grandTotal: s.order.grandTotal,
        lineCount: sql<number>`(select count(*) from order_line where order_id = ${s.order.id})::int`,
      })
      .from(s.order)
      .leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
      .where(and(...conds))
      .orderBy(asc(s.order.placedAt));
    for (const r of rows) {
      const row: ReconcileRow = {
        code: r.code, state: r.state, placedAt: r.placedAt!.toISOString(), currency: r.currency,
        email: r.email, shippingName: r.shipName, shippingLine1: r.shipLine1, shippingCity: r.shipCity, shippingCountry: r.shipCountry, shippingPostalCode: r.shipPostal,
        subtotal: r.subtotal, discountTotal: r.discountTotal, shippingTotal: r.shippingTotal, taxTotal: r.taxTotal, grandTotal: r.grandTotal, lineCount: r.lineCount,
      };
      out.write(header.map((k) => csvCell((row as unknown as Record<string, unknown>)[k])).join(',') + '\n');
      n++;
    }
  });
  return n;
}

/** Stream per-line CSV. One row per order line; links to the order via code. */
export async function streamReconcileLinesCSV(storeId: string, out: NodeJS.WritableStream, opts: { since?: Date; until?: Date } = {}): Promise<number> {
  const header = ['orderCode', 'sku', 'name', 'quantity', 'unitPrice', 'lineSubtotal', 'lineDiscount', 'lineTotal', 'fulfilledQty', 'refundedQty'];
  out.write(header.join(',') + '\n');
  let n = 0;
  await withStore(storeId, async (tx) => {
    const conds = [isNotNull(s.order.placedAt)] as ReturnType<typeof eq>[];
    if (opts.since) conds.push(gte(s.order.placedAt, opts.since) as never);
    if (opts.until) conds.push(lt(s.order.placedAt, opts.until) as never);
    const rows = await tx
      .select({
        orderCode: s.order.code, sku: s.orderLine.variantSku, name: s.orderLine.variantName,
        quantity: s.orderLine.quantity, unitPrice: s.orderLine.unitPrice,
        lineSubtotal: s.orderLine.lineSubtotal, lineDiscount: s.orderLine.lineDiscount, lineTotal: s.orderLine.lineTotal,
        fulfilledQty: s.orderLine.fulfilledQty, refundedQty: s.orderLine.refundedQty,
      })
      .from(s.orderLine)
      .innerJoin(s.order, eq(s.order.id, s.orderLine.orderId))
      .where(and(...conds))
      .orderBy(asc(s.order.placedAt), asc(s.orderLine.id));
    for (const r of rows) {
      out.write(header.map((k) => csvCell((r as unknown as Record<string, unknown>)[k])).join(',') + '\n');
      n++;
    }
  });
  return n;
}

const isCli = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('reconcile-export.ts');
if (isCli) {
  const slug = process.argv[2];
  const since = process.argv[3] ? new Date(process.argv[3]!) : undefined;
  const until = process.argv[4] ? new Date(process.argv[4]!) : undefined;
  if (!slug) { console.error('usage: tsx src/admin/reconcile-export.ts <store-slug> [since] [until]'); process.exit(2); }
  (async () => {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM store WHERE slug = $1', [slug]);
    if (!rows.length) { console.error(`store not found: ${slug}`); process.exit(2); }
    const id = rows[0]!.id;
    const orders = createWriteStream(`reconcile-orders-${slug}.csv`);
    const lines = createWriteStream(`reconcile-lines-${slug}.csv`);
    const o = await streamReconcileOrdersCSV(id, orders, { since, until });
    const l = await streamReconcileLinesCSV(id, lines, { since, until });
    orders.end(); lines.end();
    console.log(`[reconcile] ${slug}: ${o} orders, ${l} lines written.`);
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
