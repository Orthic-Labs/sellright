/**
 * Order importer: Vendure (damned_vendure) -> SellRight. Run AFTER catalog +
 * customers. Imports order header + lines + payments for all ~13.5k placed
 * orders (DD's stale-order-cleanup already purged carts, so every row is real).
 *
 * Links: order->customer by email, order_line->variant by SKU (null + snapshot
 * when the product was since deleted). order.state = payment lifecycle
 * (Refunded -> Refunded, else Paid); fulfillment state (Shipped/Delivered) is a
 * later slice on fulfillment records. Totals taken from Vendure's stored figures
 * (DD has no tax); discounts are folded into Vendure subTotal (not reconstructed
 * per line). grand_total = subTotalWithTax + shippingWithTax = what was paid.
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

const ORDER_STATE = (v: string) => (v === 'Refunded' ? 'Refunded' : 'Paid') as 'Refunded' | 'Paid';
const PAY_STATE: Record<string, 'Pending' | 'Authorized' | 'Settled' | 'Declined' | 'Failed'> = {
  Authorized: 'Authorized', Settled: 'Settled', Declined: 'Declined', Error: 'Failed',
};
const asJson = (v: unknown) => (typeof v === 'string' ? parseJson(v) : (v ?? null));
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

async function main() {
  // eslint-disable-next-line no-console
  console.log(`[import:orders] about to TRUNCATE payment, order_line, "order". 5s to abort with Ctrl-C…`);
  await new Promise<void>((r) => setTimeout(r, 5_000));
  await pool.query(`TRUNCATE "payment", "order_line", "order" CASCADE`);

  const orderMap = new Map<number, string>();

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

    // --- orders ---
    const orderRows = (
      await q(
        `SELECT o.id, o.code, o.state, o."currencyCode" AS cur, o."orderPlacedAt" AS placed,
                o."subTotal" AS sub, o."subTotalWithTax" AS subt, o.shipping AS ship, o."shippingWithTax" AS shipt,
                o."shippingAddress" AS shipaddr, o."billingAddress" AS billaddr,
                o."customFieldsIspreorder" AS ispre, c."emailAddress" AS email
         FROM "order" o LEFT JOIN customer c ON c.id = o."customerId"
         WHERE o.state NOT IN ('AddingItems','ArrangingPayment')`,
      )
    ).map((o) => {
      const id = randomUUID();
      orderMap.set(o.id, id);
      const sub = n(o.sub), subt = n(o.subt), ship = n(o.ship), shipt = n(o.shipt);
      return {
        id, storeId: DD_STORE_ID, code: o.code,
        customerId: o.email ? custByEmail.get(String(o.email).toLowerCase()) ?? null : null,
        state: ORDER_STATE(o.state), currency: o.cur ?? 'USD',
        subtotal: sub, discountTotal: 0, shippingTotal: ship,
        taxTotal: subt - sub + (shipt - ship), grandTotal: subt + shipt,
        isPreOrder: o.ispre ?? false,
        shippingAddress: asJson(o.shipaddr), billingAddress: asJson(o.billaddr),
        placedAt: parseDate(o.placed),
      };
    });
    for (const part of chunk(orderRows, 500)) await tx.insert(s.order).values(part);

    // --- order lines (snapshot sku/name; link variant by sku when it still exists) ---
    const lineRows = (
      await q(
        `SELECT ol."orderId" AS oid, ol.quantity AS qty, ol."listPrice" AS price,
                pv.sku, pt.name AS pname
         FROM order_line ol
         JOIN product_variant pv ON pv.id = ol."productVariantId"
         LEFT JOIN product_translation pt ON pt."baseId" = pv."productId" AND pt."languageCode" = 'en'`,
      )
    )
      .map((l) => {
        const orderId = orderMap.get(l.oid);
        if (!orderId) return null;
        const qty = n(l.qty), unit = n(l.price);
        return {
          storeId: DD_STORE_ID, orderId,
          variantId: variantBySku.get(l.sku) ?? null,
          variantSku: l.sku ?? '(unknown)', variantName: l.pname ?? l.sku ?? '(unknown)',
          quantity: qty, unitPrice: unit, lineSubtotal: unit * qty,
          lineDiscount: 0, lineTax: 0, lineTotal: unit * qty,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    for (const part of chunk(lineRows, 1000)) await tx.insert(s.orderLine).values(part);

    // --- payments ---
    const payRows = (
      await q(`SELECT p."orderId" AS oid, p.method, p.state, p.amount, p."transactionId" AS txn, p.metadata, p."errorMessage" AS err FROM payment p`)
    )
      .map((p) => {
        const orderId = orderMap.get(p.oid);
        if (!orderId) return null;
        return {
          storeId: DD_STORE_ID, orderId, amount: n(p.amount), method: p.method,
          providerRef: p.txn ?? null, state: PAY_STATE[p.state] ?? 'Pending',
          metadata: asJson(p.metadata), errorMessage: p.err ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    for (const part of chunk(payRows, 1000)) await tx.insert(s.payment).values(part);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ store: DD_STORE_ID, orders: orderRows.length, lines: lineRows.length, payments: payRows.length }, null, 2));
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
