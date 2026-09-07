/** Atomic Vendure migration phase. Invoke through import/run.ts. */
import * as s from '../db/schema.js';
import { chunk, parseDate, parseJson } from './store.js';
import { mapVendureOrderState, mapVendurePaymentState } from './vendure-order.js';
import { vendureLineMoney } from './vendure-money.js';

const asJson = (v: unknown) => (typeof v === 'string' ? parseJson(v) : (v ?? null));
const jsonArray = (v: unknown): Array<Record<string, unknown>> => {
  const parsed = asJson(v);
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
};
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

import type { ImportContext } from './context.js';

export async function importOrders(ctx: ImportContext): Promise<void> {
  const { tx, q } = ctx;
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

  type OrderRef = { id: string; sourceSubTotalWithTax: number };
  const orderMap = new Map<number, OrderRef>();

  {

    const customerIds = new Set((await tx.select({ id: s.customer.id }).from(s.customer)).map(row => row.id));
    const variantIds = new Set((await tx.select({ id: s.productVariant.id }).from(s.productVariant)).map(row => row.id));
    // --- orders: source header is the reconciliation authority ---
    const sourceOrders = await q(
      `SELECT o.id, o.code, o.state, o."currencyCode" AS cur, o."orderPlacedAt" AS placed,
              o."subTotal" AS sub, o."subTotalWithTax" AS subt, o.shipping AS ship, o."shippingWithTax" AS shipt,
              o."shippingAddress" AS shipaddr, o."billingAddress" AS billaddr,
              o."couponCodes" AS coupons, o."customFieldsIspreorder" AS ispre, o."customerId" AS cid, c."emailAddress" AS email, o."createdAt" AS created, o."updatedAt" AS updated
       FROM "order" o LEFT JOIN customer c ON c.id = o."customerId"
       WHERE o.state NOT IN ('AddingItems','ArrangingPayment')`,
    );

    const orderRows = sourceOrders.map((o) => {
      const id = ctx.id('order', o.id);
      const sourceSubTotalWithTax = n(o.subt);
      orderMap.set(o.id, { id, sourceSubTotalWithTax });
      const sub = n(o.sub), ship = n(o.ship), shipt = n(o.shipt);
      return {
        id, storeId: ctx.storeId, code: o.code,
        customerId: o.cid && customerIds.has(ctx.id('customer', o.cid)) ? ctx.id('customer', o.cid) : null,
        createdAt: parseDate(o.created) ?? undefined, updatedAt: parseDate(o.updated) ?? undefined,
        metadata: { vendure: { id: o.id, state: o.state, sourceKey: ctx.sourceKey, customerId: o.cid, couponCodes: o.coupons }, contact: { email: o.email } },
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
      `SELECT ol.id, ol."productVariantId" AS vid, ol."orderId" AS oid, ol.quantity AS qty, ${placedQtySql} AS placed_qty,
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
          id: ctx.id('order-line', l.id), storeId: ctx.storeId, orderId: orderRef.id,
          variantId: l.vid && variantIds.has(ctx.id('variant', l.vid)) ? ctx.id('variant', l.vid) : null,
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
      await q(`SELECT p.id, p."createdAt" AS created, p."orderId" AS oid, p.method, p.state, p.amount, p."transactionId" AS txn, p.metadata, p."errorMessage" AS err FROM payment p`)
    )
      .map((p) => {
        const orderRef = orderMap.get(p.oid);
        if (!orderRef) return null;
        const method = String(p.method).toLowerCase().replace(/-payment$/, '');
        if (!['nmi', 'sezzle', 'stripe', 'gift_card', 'manual', 'cod'].includes(method)) throw new Error('Unsupported payment method: ' + method);
        const account = ctx.gatewayAccounts[method];
        if (['nmi', 'sezzle'].includes(method) && !account) throw new Error('Original gateway account is required: ' + method);
        const metadata = asJson(p.metadata) as Record<string, unknown> | null;
        return {
          id: ctx.id('payment', p.id), storeId: ctx.storeId, orderId: orderRef.id, amount: n(p.amount), method,
          gatewayAccount: account?.accountId ?? null, gatewayMode: account?.mode ?? null,
          currency: ctx.currency, createdAt: parseDate(p.created) ?? undefined,
          providerRef: method === 'sezzle' ? String(metadata?.sezzleOrderUuid ?? p.txn ?? '') || null : p.txn ?? null, state: mapVendurePaymentState(String(p.state)),
          metadata: asJson(p.metadata), errorMessage: p.err ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    for (const part of chunk(payRows, 1000)) await tx.insert(s.payment).values(part);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ store: ctx.storeId, orders: orderRows.length, lines: lineRows.length, payments: payRows.length, moneyReconciled: true }, null, 2));
  }

}
