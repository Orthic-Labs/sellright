/**
 * Order importer: Vendure (damned_vendure) -> SellRight. Run AFTER catalog +
 * customers. Imports order header + lines + payments for all placed orders.
 *
 * Money is reconstructed from Vendure's persisted order-line adjustments and
 * tax lines, using the same prorated-line economics Vendure uses for refunds.
 * The importer reconciles every reconstructed line sum against Vendure's stored
 * subTotalWithTax and aborts the transaction on any mismatch rather than
 * importing lossy financial history.
 *
 *   SOURCE_DATABASE_URL=...damned_vendure DATABASE_URL=...sellright_dev \
 *   corepack pnpm tsx src/import/orders.ts
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { DD_STORE_ID, ensureDdStore, chunk, parseDate, parseJson } from './store.js';
import { mapVendureOrderState, mapVendurePaymentState } from './vendure-order.js';
import { vendureLineMoney } from './vendure-money.js';

const SOURCE_URL = env.SOURCE_DATABASE_URL;
if (!SOURCE_URL) throw new Error('SOURCE_DATABASE_URL is required (the damned_vendure clone)');

// WP9.4: TRUNCATE guard (mirrors catalog.ts) — requires BOTH --force and
// ALLOW_FORCE_TRUNCATE=1 to override.
const TARGET_URL = env.DATABASE_URL;
const forceFlag = process.argv.includes('--force');
const forceEnv = env.ALLOW_FORCE_TRUNCATE === '1';
const allowedTarget = /[/_](dev|test)(\b|$|\?)/.test(TARGET_URL);
if (!allowedTarget && !(forceFlag && forceEnv)) {
  throw new Error(
    `REFUSING to TRUNCATE: DATABASE_URL does not look like a dev/test instance. ` +
    `Override requires BOTH --force and ALLOW_FORCE_TRUNCATE=1. url=${TARGET_URL.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const src = new Pool({ connectionString: SOURCE_URL });
const q = async (sql: string, params: unknown[] = []) => (await src.query(sql, params)).rows;

const asJson = (v: unknown) => (typeof v === 'string' ? parseJson(v) : (v ?? null));
const jsonArray = (v: unknown): Array<Record<string, unknown>> => {
  const parsed = asJson(v);
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
};
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

async function main() {
  // Source-schema preflight. These fields have existed on Vendure OrderLine for
  // years and are required for exact historical refund economics. If a source
  // database lacks them, stop rather than falling back to listPrice * quantity.
  const lineColumnRows = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'order_line'`,
  );
  const lineColumns = new Set(lineColumnRows.map((row) => String(row.column_name)));
  for (const required of ['listPriceIncludesTax', 'adjustments', 'taxLines']) {
    if (!lineColumns.has(required)) {
      throw new Error(`Vendure source order_line is missing required column '${required}'; refusing lossy order import`);
    }
  }
  const placedQtySql = lineColumns.has('orderPlacedQuantity')
    ? `ol."orderPlacedQuantity"`
    : 'ol.quantity';

  // eslint-disable-next-line no-console
  console.log(`[import:orders] about to TRUNCATE payment, order_line, "order". 5s to abort with Ctrl-C…`);
  await new Promise<void>((r) => setTimeout(r, 5_000));
  await pool.query(`TRUNCATE "payment", "order_line", "order" CASCADE`);

  type OrderRef = { id: string; sourceSubTotalWithTax: number };
  const orderMap = new Map<number, OrderRef>();

  await withStore(DD_STORE_ID, async (tx) => {
    await ensureDdStore(tx);

    // Target lookup maps (RLS-scoped to DD).
    const custByEmail = new Map<string, string>();
    for (const c of await tx.select({ id: s.customer.id, email: s.customer.email }).from(s.customer)) {
      custByEmail.set(c.email.toLowerCase(), c.id);
    }
    const variantBySku = new Map<string, string>();
    for (const v of await tx.select({ id: s.productVariant.id, sku: s.productVariant.sku }).from(s.productVariant)) {
      variantBySku.set(v.sku, v.id);
    }

    // --- orders: source header is the reconciliation authority ---
    const sourceOrders = await q(
      `SELECT o.id, o.code, o.state, o."currencyCode" AS cur, o."orderPlacedAt" AS placed,
              o."subTotal" AS sub, o."subTotalWithTax" AS subt, o.shipping AS ship, o."shippingWithTax" AS shipt,
              o."shippingAddress" AS shipaddr, o."billingAddress" AS billaddr,
              o."customFieldsIspreorder" AS ispre, c."emailAddress" AS email
       FROM "order" o LEFT JOIN customer c ON c.id = o."customerId"
       WHERE o.state NOT IN ('AddingItems','ArrangingPayment')`,
    );

    const orderRows = sourceOrders.map((o) => {
      const id = randomUUID();
      const sourceSubTotalWithTax = n(o.subt);
      orderMap.set(o.id, { id, sourceSubTotalWithTax });
      const sub = n(o.sub), ship = n(o.ship), shipt = n(o.shipt);
      return {
        id, storeId: DD_STORE_ID, code: o.code,
        customerId: o.email ? custByEmail.get(String(o.email).toLowerCase()) ?? null : null,
        state: mapVendureOrderState(String(o.state)), currency: o.cur ?? 'USD',
        // Replaced below with line-derived pre-discount subtotal/discount/tax
        // after exact line reconciliation. Initialize from source header so the
        // object remains complete while building the line map.
        subtotal: sub, discountTotal: 0, shippingTotal: ship,
        taxTotal: sourceSubTotalWithTax - sub + (shipt - ship), grandTotal: sourceSubTotalWithTax + shipt,
        isPreOrder: o.ispre ?? false,
        shippingAddress: asJson(o.shipaddr), billingAddress: asJson(o.billaddr),
        placedAt: parseDate(o.placed),
      };
    });

    // --- order lines: reconstruct Vendure's prorated economic line values ---
    const sourceLines = await q(
      `SELECT ol."orderId" AS oid, ol.quantity AS qty, ${placedQtySql} AS placed_qty,
              ol."listPrice" AS price, ol."listPriceIncludesTax" AS includes_tax,
              ol.adjustments, ol."taxLines" AS tax_lines,
              pv.sku, pt.name AS pname
       FROM order_line ol
       JOIN product_variant pv ON pv.id = ol."productVariantId"
       LEFT JOIN product_translation pt ON pt."baseId" = pv."productId" AND pt."languageCode" = 'en'`,
    );

    type LineAgg = { subtotal: number; discount: number; tax: number; total: number };
    const lineAggByOrder = new Map<string, LineAgg>();
    const lineRows = sourceLines
      .map((l) => {
        const orderRef = orderMap.get(l.oid);
        if (!orderRef) return null;
        const quantity = n(l.qty);
        const money = vendureLineMoney({
          quantity,
          orderPlacedQuantity: n(l.placed_qty) || quantity,
          listPrice: n(l.price),
          listPriceIncludesTax: Boolean(l.includes_tax),
          adjustments: jsonArray(l.adjustments),
          taxLines: jsonArray(l.tax_lines),
        });
        const agg = lineAggByOrder.get(orderRef.id) ?? { subtotal: 0, discount: 0, tax: 0, total: 0 };
        agg.subtotal += money.lineSubtotal;
        agg.discount += money.lineDiscount;
        agg.tax += money.lineTax;
        agg.total += money.lineTotal;
        lineAggByOrder.set(orderRef.id, agg);
        return {
          storeId: DD_STORE_ID, orderId: orderRef.id,
          variantId: variantBySku.get(l.sku) ?? null,
          variantSku: l.sku ?? '(unknown)', variantName: l.pname ?? l.sku ?? '(unknown)',
          quantity, ...money,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Reconcile every order before writing a single order row. Vendure documents
    // subTotalWithTax as the sum of prorated OrderLine economics; a mismatch
    // means this source uses semantics we have not reconstructed exactly.
    const sourceByTarget = new Map<string, { sourceSubTotalWithTax: number }>();
    for (const ref of orderMap.values()) sourceByTarget.set(ref.id, ref);
    for (const row of orderRows) {
      const source = sourceByTarget.get(row.id)!;
      const agg = lineAggByOrder.get(row.id) ?? { subtotal: 0, discount: 0, tax: 0, total: 0 };
      if (agg.total !== source.sourceSubTotalWithTax) {
        throw new Error(
          `Vendure money reconciliation failed for order ${row.code}: ` +
          `reconstructed lines=${agg.total}, source subTotalWithTax=${source.sourceSubTotalWithTax}`,
        );
      }
      const shippingTax = row.grandTotal - source.sourceSubTotalWithTax - row.shippingTotal;
      row.subtotal = agg.subtotal;
      row.discountTotal = agg.discount;
      row.taxTotal = agg.tax + shippingTax;
      const reconstructedGrand = row.subtotal - row.discountTotal + row.shippingTotal + row.taxTotal;
      if (reconstructedGrand !== row.grandTotal) {
        throw new Error(
          `SellRight order reconciliation failed for ${row.code}: reconstructed=${reconstructedGrand}, source=${row.grandTotal}`,
        );
      }
    }

    for (const part of chunk(orderRows, 500)) await tx.insert(s.order).values(part);
    for (const part of chunk(lineRows, 1000)) await tx.insert(s.orderLine).values(part);

    // --- payments ---
    const payRows = (
      await q(`SELECT p."orderId" AS oid, p.method, p.state, p.amount, p."transactionId" AS txn, p.metadata, p."errorMessage" AS err FROM payment p`)
    )
      .map((p) => {
        const orderRef = orderMap.get(p.oid);
        if (!orderRef) return null;
        return {
          storeId: DD_STORE_ID, orderId: orderRef.id, amount: n(p.amount), method: p.method,
          providerRef: p.txn ?? null, state: mapVendurePaymentState(String(p.state)),
          metadata: asJson(p.metadata), errorMessage: p.err ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    for (const part of chunk(payRows, 1000)) await tx.insert(s.payment).values(part);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ store: DD_STORE_ID, orders: orderRows.length, lines: lineRows.length, payments: payRows.length, moneyReconciled: true }, null, 2));
  });

  await src.end();
  await pool.end();
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await src.end(); } catch { /* noop */ }
    try { await pool.end(); } catch { /* noop */ }
  });
