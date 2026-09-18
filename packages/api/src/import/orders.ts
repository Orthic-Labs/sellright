/** Atomic Vendure migration phase. Invoke through import/run.ts. */
import { eq } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { chunk, parseDate, parseJson } from './store.js';
import { optionalColumn } from './source-schema.js';
import { mapVendureOrderState, mapVendurePaymentState } from './vendure-order.js';
import { vendureLineMoney } from './vendure-money.js';

const asJson = (v: unknown) => (typeof v === 'string' ? parseJson(v) : (v ?? null));
const jsonArray = (v: unknown): Array<Record<string, unknown>> => {
  const parsed = asJson(v);
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
};
function address(value: unknown) {
  const raw = asJson(value) as Record<string, unknown> | null;
  if (!raw) return null;
  return { ...raw, line1: raw.streetLine1 ?? raw.line1, line2: raw.streetLine2 ?? raw.line2,
    phone: raw.phoneNumber ?? raw.phone, country: raw.countryCode ?? raw.country };
}
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

import type { ImportContext } from './context.js';

/**
 * Transaction-level mode evidence: a gateway may record the mode a charge
 * actually ran under inside the payment row's own metadata — the only source
 * artifact that can carry the ORIGINAL mode (the payment_method row's handler
 * config is CURRENT state and can have drifted since the transaction). Boolean
 * flags carry polarity in the key name (testMode:false = live, live:false =
 * test); string keys name the mode directly. Returns null when no plausible
 * key is present — absence of evidence is never itself evidence.
 */
export function vendurePaymentMetadataMode(metadata: Record<string, unknown> | null): 'test' | 'live' | null {
  if (!metadata) return null;
  const flag = (v: unknown): boolean | null =>
    v === true || v === 'true' || v === 1 || v === '1' ? true
      : v === false || v === 'false' || v === 0 || v === '0' ? false : null;
  for (const key of ['testMode', 'test_mode', 'isTestMode', 'isTest', 'test', 'sandbox']) {
    const v = flag(metadata[key]);
    if (v != null) return v ? 'test' : 'live';
  }
  for (const key of ['live', 'isLive', 'liveMode', 'live_mode', 'production']) {
    const v = flag(metadata[key]);
    if (v != null) return v ? 'live' : 'test';
  }
  for (const key of ['mode', 'gatewayMode', 'gateway_mode', 'environment', 'env']) {
    const v = typeof metadata[key] === 'string' ? (metadata[key] as string).toLowerCase() : null;
    if (v === 'test' || v === 'sandbox' || v === 'staging') return 'test';
    if (v === 'live' || v === 'production' || v === 'prod') return 'live';
  }
  return null;
}

export async function importOrders(ctx: ImportContext): Promise<void> {
  const { tx, q } = ctx;
  // Source-schema preflight (SR-08) already classified order_line columns.
  // These fields have existed on Vendure OrderLine for years and are required
  // for exact historical refund economics — keep the local guard too, since a
  // phase must never fall back to listPrice * quantity.
  const lineColumns = ctx.sourceColumns.get('order_line') ?? new Set<string>();
  for (const required of ['listPriceIncludesTax', 'adjustments', 'taxLines']) {
    if (!lineColumns.has(required)) {
      throw new Error(`Vendure source order_line is missing required column '${required}'; refusing lossy order import`);
    }
  }
  const placedQtySql = lineColumns.has('orderPlacedQuantity')
    ? `ol."orderPlacedQuantity"`
    : 'ol.quantity';

  type OrderRef = { id: string; vendureOid: number; sourceSubTotalWithTax: number };
  const orderMap = new Map<number, OrderRef>();

  {

    // Every tenant-table select carries an explicit store_id predicate: the
    // migration role may hold BYPASSRLS (test fixtures run as superuser), so
    // RLS alone is not a tenant boundary here.
    const customerIds = new Set((await tx.select({ id: s.customer.id }).from(s.customer)
      .where(eq(s.customer.storeId, ctx.storeId))).map(row => row.id));
    const variantIds = new Set((await tx.select({ id: s.productVariant.id }).from(s.productVariant)
      .where(eq(s.productVariant.storeId, ctx.storeId))).map(row => row.id));
    // coupon code -> imported promotion, for order.promotionId attribution
    // (SR-09: affiliate balances are computed from orders carrying the
    // affiliate's promotion). Backfilled affiliate promotions are already
    // present — the business phase runs first.
    const promotionByCode = new Map<string, string>();
    for (const promo of await tx.select({ id: s.promotion.id, code: s.promotion.code }).from(s.promotion)
      .where(eq(s.promotion.storeId, ctx.storeId))) {
      if (promo.code && !promotionByCode.has(promo.code)) promotionByCode.set(promo.code, promo.id);
    }
    const couponsOf = (value: unknown): string[] =>
      // Vendure couponCodes is a simple-array (comma-joined text); accept a
      // real array too in case a source extension changed the column type.
      Array.isArray(value) ? value.map(String).filter(Boolean)
        : typeof value === 'string' ? value.split(',').map(code => code.trim()).filter(Boolean) : [];
    // SR-08: order.isPreOrder is a DD custom field; RH does not declare it.
    const ispreSql = optionalColumn(ctx.sourceColumns, 'order', 'customFieldsIspreorder', 'o', 'ispre');
    // --- orders: source header is the reconciliation authority ---
    const sourceOrders = await q(
      `SELECT o.id, o.code, o.state, o."currencyCode" AS cur, o."orderPlacedAt" AS placed,
              o."subTotal" AS sub, o."subTotalWithTax" AS subt, o.shipping AS ship, o."shippingWithTax" AS shipt,
              o."shippingAddress" AS shipaddr, o."billingAddress" AS billaddr,
              o."couponCodes" AS coupons, ${ispreSql}, o."customerId" AS cid, c."emailAddress" AS email, o."createdAt" AS created, o."updatedAt" AS updated
       FROM "order" o LEFT JOIN customer c ON c.id = o."customerId"
       WHERE o.state NOT IN ('AddingItems','ArrangingPayment')`,
    );

    // Captured money is the strongest evidence when source aggregates disagree:
    // real DD data has orders whose header subTotalWithTax is stale relative to
    // their order_lines, while the settled payment matches the lines exactly.
    // Net captured = settled payments - settled refunds, per source order.
    const netPaidByOrder = new Map<number, number>();
    for (const row of await q(
      `SELECT p."orderId" AS oid, SUM(p.amount)::bigint AS settled FROM payment p WHERE p.state='Settled' GROUP BY 1`,
    )) netPaidByOrder.set(Number(row.oid), Number(row.settled));
    for (const row of await q(
      `SELECT p."orderId" AS oid, SUM(r.total)::bigint AS refunded FROM refund r JOIN payment p ON p.id=r."paymentId" WHERE r.state='Settled' GROUP BY 1`,
    )) {
      const oid = Number(row.oid);
      netPaidByOrder.set(oid, (netPaidByOrder.get(oid) ?? 0) - Number(row.refunded));
    }

    const orderRows = sourceOrders.map((o) => {
      if (!['Cancelled','Refunded','PartiallyRefunded','PaymentSettled','PartiallyShipped','Shipped','PartiallyDelivered','Delivered','PaymentAuthorized','Modifying'].includes(o.state)) {
        throw new Error('Unsupported source order state: ' + o.state);
      }
      const id = ctx.id('order', o.id);
      const sourceSubTotalWithTax = n(o.subt);
      orderMap.set(o.id, { id, vendureOid: o.id, sourceSubTotalWithTax });
      const sub = n(o.sub), ship = n(o.ship), shipt = n(o.shipt);
      const coupons = couponsOf(o.coupons);
      return {
        id, storeId: ctx.storeId, code: o.code,
        customerId: o.cid && customerIds.has(ctx.id('customer', o.cid)) ? ctx.id('customer', o.cid) : null,
        // Single-coupon v1: attribute the order to the first source coupon that
        // maps to an imported promotion. Every source code stays in metadata.
        promotionId: coupons.map(code => promotionByCode.get(code)).find(Boolean) ?? null,
        createdAt: parseDate(o.created) ?? undefined, updatedAt: parseDate(o.updated) ?? undefined,
        metadata: { vendure: { id: o.id, state: o.state, sourceKey: ctx.sourceKey, customerId: o.cid, couponCodes: o.coupons }, contact: { email: o.email } },
        state: mapVendureOrderState(String(o.state)), currency: o.cur ?? 'USD',
        // Replaced below with line-derived pre-discount subtotal/discount/tax
        // after exact line reconciliation. Initialize from source header so the
        // object remains complete while building the line map.
        subtotal: sub, discountTotal: 0, shippingTotal: ship,
        taxTotal: sourceSubTotalWithTax - sub + (shipt - ship), grandTotal: sourceSubTotalWithTax + shipt,
        isPreOrder: o.ispre ?? false,
        shippingAddress: address(o.shipaddr), billingAddress: address(o.billaddr),
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
          metadata: { vendure: { id: l.id, variantId: l.vid, quantity,
            placedQuantity: n(l.placed_qty) || quantity, listPrice: n(l.price),
            listPriceIncludesTax: Boolean(l.includes_tax), adjustments: jsonArray(l.adjustments), taxLines: jsonArray(l.tax_lines) } },
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Reconcile every order before writing a single order row. Vendure documents
    // subTotalWithTax as the sum of prorated OrderLine economics; a mismatch
    // means this source uses semantics we have not reconstructed exactly.
    const sourceByTarget = new Map<string, OrderRef>();
    for (const ref of orderMap.values()) sourceByTarget.set(ref.id, ref);
    for (const row of orderRows) {
      const source = sourceByTarget.get(row.id)!;
      const agg = lineAggByOrder.get(row.id) ?? { subtotal: 0, discount: 0, tax: 0, total: 0 };
      const header = source.sourceSubTotalWithTax;
      const shippingTax = row.grandTotal - header - row.shippingTotal;
      if (agg.total !== header) {
        // Source drift: real DD data has orders whose header contradicts their
        // lines (stale header) or whose captured payment matches neither (e.g.
        // shipping-only captures). Captured money adjudicates: when the net
        // settled payment equals reconstructed lines + shipping, the lines are
        // proven and the header is stale. Otherwise the source header is kept
        // (never invent totals) and the drift lands on the manifest for review.
        const netPaid = netPaidByOrder.get(source.vendureOid);
        if (netPaid !== undefined && netPaid === agg.total + row.shippingTotal + shippingTax) {
          row.grandTotal = agg.total + row.shippingTotal + shippingTax;
          row.subtotal = agg.subtotal;
          row.discountTotal = agg.discount;
          row.taxTotal = agg.tax + shippingTax;
          ctx.exclusions.push({ type: 'unmappable-source-row', table: 'order',
            detail: `order ${row.code}: header subTotalWithTax=${header} stale vs reconstructed lines=${agg.total}; settled payment corroborates lines — imported line-derived totals` });
        } else {
          ctx.exclusions.push({ type: 'unmappable-source-row', table: 'order',
            detail: `order ${row.code}: header subTotalWithTax=${header} disagrees with reconstructed lines=${agg.total} and net settled payment=${netPaid ?? 'none'} — imported source header, review required` });
          continue;
        }
      } else {
        const shippingTaxFromHeader = shippingTax;
        row.subtotal = agg.subtotal;
        row.discountTotal = agg.discount;
        row.taxTotal = agg.tax + shippingTaxFromHeader;
      }
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
    // SR-03: provenance + historical mode identity for imported payments. The
    // source payment_method table's handler config is the CURRENT method
    // configuration — a method could have run live and later been switched to
    // test, so its present testMode is corroborating evidence only, never the
    // sole basis for an old transaction's mode. Original mode resolves in
    // precedence order:
    //   (a) transaction-level evidence — a mode key in the payment row's own
    //       metadata is the transaction's own record and wins outright;
    //   (b) the operator-declared gatewayAccounts[method].mode — a declared
    //       mapping IS the reviewed, verified historical account mapping;
    //   (c) neither → QUARANTINE: the row still imports (the financial record
    //       must exist) with gateway_mode NULL,
    //       metadata.vendure.modeQuarantined='unresolved', and a manifest
    //       exclusion entry.
    // When the current source config CONTRADICTS a declared account mode the
    // payment quarantines as 'conflict' rather than throwing — unresolved
    // identity is reviewed, never silently trusted and never fatal. A MISSING
    // gatewayAccounts entry for a gateway method stays a hard error: the
    // account identity itself must be declared.
    const sourceMethodMode = new Map<string, 'test' | 'live'>();
    for (const pm of await q('SELECT code, handler FROM payment_method')) {
      const handler = typeof pm.handler === 'string' ? parseJson(pm.handler) : pm.handler;
      const args = handler && typeof handler === 'object'
        ? ((handler as { args?: unknown; arguments?: unknown }).args ?? (handler as { arguments?: unknown }).arguments)
        : undefined;
      const testMode = Array.isArray(args)
        ? (args as Array<{ name?: unknown; value?: unknown }>).find(arg => arg?.name === 'testMode')?.value
        : undefined;
      if (testMode === true || testMode === 'true' || testMode === false || testMode === 'false') {
        sourceMethodMode.set(String(pm.code), (testMode === true || testMode === 'true') ? 'test' : 'live');
      }
    }
    let sentinelProviderRefs = 0;
    const payRows = (
      await q(`SELECT p.id, p."createdAt" AS created, p."orderId" AS oid, p.method, p.state, p.amount, p."transactionId" AS txn, p.metadata, p."errorMessage" AS err FROM payment p`)
    )
      .map((p) => {
        const orderRef = orderMap.get(p.oid);
        if (!orderRef) return null;
        const sourceMethod = String(p.method);
        let method = sourceMethod.toLowerCase().replace(/-payment$/, '');
        // Vendure's built-in `standard-payment` uses the dummy handler — it is
        // an operator-recorded capture (real DD rows exist), i.e. `manual`.
        if (method === 'standard') method = 'manual';
        if (!['nmi', 'sezzle', 'stripe', 'gift_card', 'manual', 'cod'].includes(method)) throw new Error('Unsupported payment method: ' + method);
        const account = ctx.gatewayAccounts[method];
        if (['nmi', 'sezzle', 'stripe'].includes(method) && !account) throw new Error('Original gateway account is required: ' + method);
        const rawMetadata = asJson(p.metadata);
        const metadata = rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
          ? rawMetadata as Record<string, unknown>
          : null;
        const txnMode = vendurePaymentMetadataMode(metadata);
        const declared = account?.mode ?? null;
        const sourceMode = sourceMethodMode.get(sourceMethod) ?? null;
        let mode: 'test' | 'live' | null = null;
        let modeQuarantined: 'unresolved' | 'conflict' | null = null;
        if (txnMode) {
          mode = txnMode; // (a) the transaction's own record outranks any config
        } else if (declared && sourceMode && sourceMode !== declared) {
          modeQuarantined = 'conflict'; // corroborating evidence contradicts the declaration
        } else if (declared) {
          mode = declared; // (b) the reviewed declaration IS the historical mapping
        } else {
          // (c) no authoritative evidence — flag, don't guess. Only gateway
          // methods quarantine: cod/manual/gift_card have no gateway mode to
          // resolve, so a NULL mode there is absence, not uncertainty.
          modeQuarantined = ['nmi', 'sezzle', 'stripe'].includes(method) ? 'unresolved' : null;
        }
        const provenance: Record<string, unknown> = { vendureMethod: sourceMethod, sourceMode };
        if (txnMode) provenance.txnMode = txnMode;
        // `transactionId='imported'` (and empty) is a migration sentinel in the
        // source, not a real gateway reference — real DD data carries it on
        // ~12k payments from its own prior platform migration. Importing it
        // verbatim collides on payment_store_provider_ref_uidx, so the real
        // provider_ref becomes NULL while the sentinel stays in provenance.
        const rawTxn = p.txn == null ? null : String(p.txn);
        const sentinelTxn = !rawTxn || rawTxn === 'imported';
        if (sentinelTxn) { sentinelProviderRefs++; provenance.transactionId = rawTxn; }
        if (modeQuarantined) {
          provenance.modeQuarantined = modeQuarantined;
          ctx.exclusions.push({ type: 'unmappable-source-row', table: 'payment',
            detail: modeQuarantined === 'conflict'
              ? `payment ${p.id} (${sourceMethod}): modeQuarantined=conflict — source method config records ${sourceMode} mode but the declared account mode is ${declared}; imported with gateway_mode NULL`
              : `payment ${p.id} (${sourceMethod}): modeQuarantined=unresolved — no transaction-level or declared gateway-mode evidence; imported with gateway_mode NULL`,
            count: 1 });
        }
        return {
          id: ctx.id('payment', p.id), storeId: ctx.storeId, orderId: orderRef.id, amount: n(p.amount), method,
          gatewayAccount: account?.accountId ?? null, gatewayMode: mode,
          currency: ctx.currency, createdAt: parseDate(p.created) ?? undefined,
          providerRef: sentinelTxn && method !== 'sezzle' ? null
            : method === 'sezzle' ? (String(metadata?.sezzleOrderUuid ?? '') || (sentinelTxn ? null : rawTxn))
            : rawTxn,
          state: mapVendurePaymentState(String(p.state)),
          metadata: metadata
            ? { ...metadata, vendure: provenance }
            : { vendure: provenance, source: rawMetadata ?? null },
          errorMessage: p.err ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (sentinelProviderRefs) {
      ctx.exclusions.push({ type: 'unmappable-source-row', table: 'payment',
        detail: `${sentinelProviderRefs} payments carried a sentinel transactionId (e.g. 'imported' from the source's own prior platform migration) — provider_ref imported NULL, sentinel preserved in metadata.vendure.transactionId`,
        count: sentinelProviderRefs });
    }
    for (const part of chunk(payRows, 1000)) await tx.insert(s.payment).values(part);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ store: ctx.storeId, orders: orderRows.length, lines: lineRows.length, payments: payRows.length, moneyReconciled: true }, null, 2));
  }

}
