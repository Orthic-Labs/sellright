/** Atomic Vendure migration phase. Invoke through import/run.ts. */
import { eq } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { chunk, parseDate, parseJson } from './store.js';
import { optionalColumn } from './source-schema.js';
import { mapVendureOrderState, mapVendurePaymentState } from './vendure-order.js';
import { vendureExactLineMoney, vendureMoneySum, vendureOrderChargeProjection, vendureShippingMoney,
  vendureSourceInteger, vendureSourceRecord, vendureSurchargeMoney, type VendureFinancialHeader } from './order-charges.js';
import { digest } from './artifacts.js';

const asJson = (v: unknown) => (typeof v === 'string' ? parseJson(v) : (v ?? null));
function address(value: unknown) {
  const raw = asJson(value) as Record<string, unknown> | null;
  if (!raw) return null;
  return { ...raw, line1: raw.streetLine1 ?? raw.line1, line2: raw.streetLine2 ?? raw.line2,
    phone: raw.phoneNumber ?? raw.phone, country: raw.countryCode ?? raw.country };
}
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

import type { ImportContext } from './context.js';
import { bumpOrderNumberPastExisting } from '../orders/order-number.js';

/** Source simple-array identity uses lowercase equality, without trimming. */
export function importedCouponCodes(value: unknown, canonicalCodes: ReadonlyMap<string, string> = new Map()): {
  codes: string[]; invalidCount: number; duplicateCount: number;
} {
  const members: unknown[] = value == null || value === '' ? []
    : Array.isArray(value) ? value
      : typeof value === 'string' ? value.split(',') : [value];
  const codes: string[] = [];
  const seen = new Set<string>();
  let invalidCount = 0, duplicateCount = 0;
  for (const member of members) {
    if (typeof member !== 'string' || member.length === 0) {
      invalidCount++;
      continue;
    }
    const identity = member.toLowerCase();
    if (seen.has(identity)) {
      duplicateCount++;
      continue;
    }
    seen.add(identity);
    codes.push(canonicalCodes.get(identity) ?? member);
  }
  return { codes, invalidCount, duplicateCount };
}

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

  type OrderRef = { id: string; vendureOid: number; header: VendureFinancialHeader };
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
    const canonicalCodes = new Map<string, string>();
    const ambiguousCodes = new Set<string>();
    for (const promo of await tx.select({ id: s.promotion.id, code: s.promotion.code }).from(s.promotion)
      .where(eq(s.promotion.storeId, ctx.storeId))) {
      if (!promo.code) continue;
      const identity = promo.code.toLowerCase();
      if (ambiguousCodes.has(identity)) continue;
      if (promotionByCode.has(identity)) {
        promotionByCode.delete(identity);
        canonicalCodes.delete(identity);
        ambiguousCodes.add(identity);
        ctx.exclusions.push({ type: 'unmappable-source-row', table: 'promotion', blocking: true,
          detail: 'Case-insensitive coupon identity matches multiple target promotions; order attribution requires reconciliation', count: 1 });
        continue;
      }
      promotionByCode.set(identity, promo.id);
      canonicalCodes.set(identity, promo.code);
    }
    // SR-08: order.isPreOrder is a DD custom field; RH does not declare it.
    const ispreSql = optionalColumn(ctx.sourceColumns, 'order', 'customFieldsIspreorder', 'o', 'ispre');
    // --- orders: source header is the reconciliation authority ---
    const sourceOrders = await q(
      `SELECT o.id, o.code, o.state, o."currencyCode" AS cur, o."orderPlacedAt" AS placed,
              o."subTotal"::text AS sub, o."subTotalWithTax"::text AS subt, o.shipping::text AS ship, o."shippingWithTax"::text AS shipt,
              to_jsonb(o)::text AS source_record,
              o."shippingAddress" AS shipaddr, o."billingAddress" AS billaddr,
              o."couponCodes" AS coupons, ${ispreSql}, o."customerId" AS cid, c."emailAddress" AS email, o."createdAt" AS created, o."updatedAt" AS updated
       FROM "order" o LEFT JOIN customer c ON c.id = o."customerId"
       WHERE o.state NOT IN ('AddingItems','ArrangingPayment')`,
    );
    const selectedSourceOrders = new Set(sourceOrders.map(row => Number(row.id)));

    // Settlement corroboration is retained diagnostic evidence. It cannot select
    // reconstructed charges over a contradictory stored source header.
    // Net captured = settled payments - settled refunds, per source order.
    const netPaidByOrder = new Map<number, number>();
    const settlementByOrder = new Map<number, { payments: Array<{ sourceId: string; sourceRecord: string }>;
      refunds: Array<{ sourceId: string; sourceRecord: string }> }>();
    const settlement = (oid: number) => {
      const proof = settlementByOrder.get(oid) ?? { payments: [], refunds: [] };
      settlementByOrder.set(oid, proof);
      return proof;
    };
    for (const row of await q(
      `SELECT p.id::text AS id, p."orderId" AS oid, p.amount::text AS settled, to_jsonb(p)::text AS source_record
       FROM payment p WHERE p.state='Settled' ORDER BY p.id`,
    )) {
      const oid = Number(row.oid);
      if (!selectedSourceOrders.has(oid)) continue;
      netPaidByOrder.set(oid, vendureMoneySum([netPaidByOrder.get(oid) ?? 0, vendureSourceInteger(row.settled, 'payment.amount')]));
      settlement(oid).payments.push({ sourceId: row.id, sourceRecord: row.source_record });
    }
    for (const row of await q(
      `SELECT r.id::text AS id, p."orderId" AS oid, r.total::text AS refunded, to_jsonb(r)::text AS source_record
       FROM refund r JOIN payment p ON p.id=r."paymentId" WHERE r.state='Settled' ORDER BY r.id`,
    )) {
      const oid = Number(row.oid);
      if (!selectedSourceOrders.has(oid)) continue;
      netPaidByOrder.set(oid, vendureMoneySum([netPaidByOrder.get(oid) ?? 0, -vendureSourceInteger(row.refunded, 'refund.total')]));
      settlement(oid).refunds.push({ sourceId: row.id, sourceRecord: row.source_record });
    }

    const surchargesByOrder = new Map<number, ReturnType<typeof vendureSurchargeMoney>[]>();
    for (const row of await q(`SELECT c."orderId" AS oid, to_jsonb(c)::text AS source_record FROM surcharge c ORDER BY c.id`)) {
      const oid = Number(row.oid);
      if (!selectedSourceOrders.has(oid)) continue;
      const raw = vendureSourceRecord(row.source_record);
      const rows = surchargesByOrder.get(oid) ?? [];
      rows.push(vendureSurchargeMoney(raw));
      surchargesByOrder.set(oid, rows);
    }
    const shippingMoneyByOrder = new Map<number, ReturnType<typeof vendureShippingMoney>[]>();
    for (const row of await q(`SELECT sl."orderId" AS oid, to_jsonb(sl)::text AS source_record FROM shipping_line sl ORDER BY sl.id`)) {
      const oid = Number(row.oid);
      if (!selectedSourceOrders.has(oid)) continue;
      const raw = vendureSourceRecord(row.source_record);
      const rows = shippingMoneyByOrder.get(oid) ?? [];
      rows.push(vendureShippingMoney(raw));
      shippingMoneyByOrder.set(oid, rows);
    }

    // The shipping method each source order was placed with (first shipping line
    // by id; Vendure orders carry one). Code + English name snapshot, so imported
    // history shows the method and order edits need not infer it from the total.
    const shippingByOrder = new Map<number, { code: string | null; name: string | null }>();
    for (const row of await q(
      `SELECT DISTINCT ON (sl."orderId") sl."orderId" AS oid, m.code AS code, t.name AS name
       FROM shipping_line sl
       JOIN shipping_method m ON m.id = sl."shippingMethodId"
       LEFT JOIN shipping_method_translation t ON t."baseId" = m.id AND t."languageCode" = 'en'
       ORDER BY sl."orderId", sl.id`,
    )) shippingByOrder.set(Number(row.oid), { code: row.code ?? null, name: row.name ?? null });

    const orderRows = sourceOrders.map((o) => {
      if (!['Cancelled','Refunded','PartiallyRefunded','PaymentSettled','PartiallyShipped','Shipped','PartiallyDelivered','Delivered','PaymentAuthorized','Modifying'].includes(o.state)) {
        throw new Error('Unsupported source order state: ' + o.state);
      }
      const id = ctx.id('order', o.id);
      const sourceSubTotalWithTax = vendureSourceInteger(o.subt, 'order.subTotalWithTax');
      const sub = vendureSourceInteger(o.sub, 'order.subTotal'), ship = vendureSourceInteger(o.ship, 'order.shipping');
      const shipt = vendureSourceInteger(o.shipt, 'order.shippingWithTax');
      orderMap.set(o.id, { id, vendureOid: o.id, header: { subTotal: sub, subTotalWithTax: sourceSubTotalWithTax, shipping: ship, shippingWithTax: shipt } });
      const coupons = importedCouponCodes(o.coupons, canonicalCodes);
      if (coupons.invalidCount) ctx.exclusions.push({ type: 'unmapped-source-field', table: 'order', blocking: true,
        detail: 'Invalid source couponCodes members retained in private order metadata; valid coupon membership imported', count: coupons.invalidCount });
      if (coupons.duplicateCount) ctx.exclusions.push({ type: 'merged-duplicate', table: 'order',
        detail: 'Historical case-insensitive coupon duplicates retained in private order metadata; runtime membership deduplicated', count: coupons.duplicateCount });
      return {
        id, storeId: ctx.storeId, code: o.code,
        customerId: o.cid && customerIds.has(ctx.id('customer', o.cid)) ? ctx.id('customer', o.cid) : null,
        // Compatibility attribution follows the first mapped source coupon;
        // membership order does not imply promotion execution order.
        promotionId: coupons.codes.map(code => promotionByCode.get(code.toLowerCase())).find(Boolean) ?? null,
        couponCodes: coupons.codes,
        createdAt: parseDate(o.created) ?? undefined, updatedAt: parseDate(o.updated) ?? undefined,
        metadata: { vendure: { id: o.id, state: o.state, sourceKey: ctx.sourceKey, customerId: o.cid, couponCodes: o.coupons,
          sourceOrderRecord: o.source_record,
          sourceHeader: { subTotal: String(o.sub), subTotalWithTax: String(o.subt), shipping: String(o.ship), shippingWithTax: String(o.shipt) },
        } as Record<string, unknown>, contact: { email: o.email } },
        state: mapVendureOrderState(String(o.state)), currency: o.cur ?? 'USD',
        // Preserve source header values unless every reconstructed header field
        // agrees. Settlement corroboration cannot override stored history.
        subtotal: sub, discountTotal: 0, shippingTotal: ship,
        taxTotal: vendureMoneySum([sourceSubTotalWithTax, -sub, shipt, -ship]), grandTotal: vendureMoneySum([sourceSubTotalWithTax, shipt]),
        isPreOrder: o.ispre ?? false,
        shippingMethodCode: shippingByOrder.get(Number(o.id))?.code ?? null,
        shippingMethodName: shippingByOrder.get(Number(o.id))?.name ?? null,
        shippingAddress: address(o.shipaddr), billingAddress: address(o.billaddr),
        placedAt: parseDate(o.placed),
      };
    });

    // --- order lines: reconstruct Vendure's prorated economic line values ---
    const sourceLines = await q(
      `SELECT ol.id, ol."productVariantId" AS vid, ol."orderId" AS oid, ol.quantity::text AS qty, ${placedQtySql}::text AS placed_qty,
              ol."listPrice"::text AS price, ol."listPriceIncludesTax" AS includes_tax,
              ol.adjustments::text AS adjustments, ol."taxLines"::text AS tax_lines,
              pv.sku, pt.name AS pname
       FROM order_line ol
       JOIN product_variant pv ON pv.id = ol."productVariantId"
       LEFT JOIN product_translation pt ON pt."baseId" = pv."productId" AND pt."languageCode" = 'en'`,
    );

    const lineMoneyByOrder = new Map<string, ReturnType<typeof vendureExactLineMoney>['money'][]>();
    const lineRows = sourceLines
      .map((l) => {
        const orderRef = orderMap.get(l.oid);
        if (!orderRef) return null;
        const exact = vendureExactLineMoney({ quantity: l.qty, orderPlacedQuantity: l.placed_qty, listPrice: l.price,
          listPriceIncludesTax: l.includes_tax, adjustments: l.adjustments, taxLines: l.tax_lines });
        const { quantity, placedQuantity, money } = exact;
        const group = lineMoneyByOrder.get(orderRef.id) ?? [];
        group.push(money);
        lineMoneyByOrder.set(orderRef.id, group);
        return {
          id: ctx.id('order-line', l.id), storeId: ctx.storeId, orderId: orderRef.id,
          variantId: l.vid && variantIds.has(ctx.id('variant', l.vid)) ? ctx.id('variant', l.vid) : null,
          variantSku: l.sku ?? '(unknown)', variantName: l.pname ?? l.sku ?? '(unknown)',
          quantity, ...money,
          metadata: { vendure: { id: l.id, variantId: l.vid, quantity,
            placedQuantity, listPrice: exact.listPrice,
            listPriceIncludesTax: exact.listPriceIncludesTax, adjustments: exact.adjustments, taxLines: exact.taxLines } },
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // DefaultOrderTaxCalculationStrategy sums merchandise & signed surcharges
    // separately from discounted ShippingLine getters. No header residual is tax.
    const adjustmentRows: Array<typeof s.orderAdjustment.$inferInsert> = [];
    const sourceByTarget = new Map<string, OrderRef>();
    for (const ref of orderMap.values()) sourceByTarget.set(ref.id, ref);
    for (const row of orderRows) {
      const source = sourceByTarget.get(row.id)!;
      const surcharges = surchargesByOrder.get(source.vendureOid) ?? [];
      const shipping = shippingMoneyByOrder.get(source.vendureOid) ?? [];
      const projection = vendureOrderChargeProjection({ lines: lineMoneyByOrder.get(row.id) ?? [], surcharges, shipping,
        header: source.header, netSettled: netPaidByOrder.get(source.vendureOid) });
      row.metadata.vendure.chargeProjectionV1 = { version: 1, status: projection.status, expected: projection.expected,
        sourceHeader: row.metadata.vendure.sourceHeader,
        surcharges: surcharges.map(charge => ({ sourceId: charge.sourceId,
          adjustmentId: ctx.id('order-adjustment', charge.sourceId), net: charge.net, gross: charge.gross })), shipping,
        ...(projection.status === 'settled-corroborated' ? { settlementProof: { ...settlementByOrder.get(source.vendureOid)!,
          netSettled: String(netPaidByOrder.get(source.vendureOid)) } } : {}) };
      if (projection.status !== 'exact-header') {
        ctx.exclusions.push({ type: 'unmappable-source-row', table: 'order', blocking: false,
          detail: `order ${row.code}: known_historical_financial_quarantine HEADER_CHARGE_CONTRADICTION; source header retained; reconstructed charges & net settlement are diagnostic only; financial reconciliation required`,
          sourceValues: [JSON.stringify(row.metadata.vendure.chargeProjectionV1)] });
        continue;
      }
      Object.assign(row, projection.totals);
      for (const charge of surcharges) adjustmentRows.push({ id: ctx.id('order-adjustment', charge.sourceId),
        storeId: ctx.storeId, orderId: row.id, label: charge.label, amount: charge.net });
      const reconstructedGrand = vendureMoneySum([row.subtotal, -row.discountTotal, row.shippingTotal, row.taxTotal, projection.adjustmentTotal]);
      if (reconstructedGrand !== row.grandTotal) {
        throw new Error(
          `SellRight order reconciliation failed for ${row.code}: reconstructed=${reconstructedGrand}, source=${row.grandTotal}`,
        );
      }
    }

    for (const part of chunk(orderRows, 500)) await tx.insert(s.order).values(part);
    // #309: imported orders keep their codes; the store's counter moves past the highest imported code that
    // matches its order-number format, so the next native order never collides with history.
    await bumpOrderNumberPastExisting(tx, ctx.storeId);
    for (const part of chunk(lineRows, 1000)) await tx.insert(s.orderLine).values(part);
    for (const part of chunk(adjustmentRows, 1000)) await tx.insert(s.orderAdjustment).values(part);

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
    const archivedRows: Array<typeof s.financialPaymentArchive.$inferInsert> = [];
    const payRows = (
      await q(`SELECT p.*, to_jsonb(p)::text AS source_record, to_jsonb(p)->>'createdAt' AS source_created_at,
        CASE WHEN p.metadata IS NULL THEN NULL ELSE to_jsonb(p.metadata)::text END AS source_metadata,
        p."createdAt" AS created, p."orderId" AS oid, p."transactionId" AS txn, p."errorMessage" AS err FROM payment p`)
    )
      .map((p) => {
        const orderRef = orderMap.get(p.oid);
        if (!orderRef) {
          // Preserve source facts without inventing an order or operational payment.
          archivedRows.push({ id: ctx.id('financial-payment-archive', p.id), storeId: ctx.storeId,
            sourceKey: ctx.sourceKey, sourceId: String(p.id),
            sourceDigest: digest({ format: 'retained-pg-jsonb-text-v1', payment: p.source_record, refunds: [], references: [] }),
            sourceCreatedAt: p.source_created_at, sourceOrderId: p.oid == null ? null : String(p.oid),
            method: p.method, state: p.state, amount: p.amount, transactionId: p.txn,
            metadata: p.source_metadata, errorMessage: p.err, importCurrencyContext: ctx.currency, sourceRecord: p.source_record });
          return null;
        }
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
        const provenance: Record<string, unknown> = {
          vendureMethod: sourceMethod, sourceMode, sourcePaymentId: p.id, sourceKey: ctx.sourceKey,
        };
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
    for (const part of chunk(archivedRows, 500)) await tx.insert(s.financialPaymentArchive).values(part);
    if (sentinelProviderRefs) {
      ctx.exclusions.push({ type: 'unmappable-source-row', table: 'payment',
        detail: `${sentinelProviderRefs} payments carried a sentinel transactionId (e.g. 'imported' from the source's own prior platform migration) — provider_ref imported NULL, sentinel preserved in metadata.vendure.transactionId`,
        count: sentinelProviderRefs });
    }
    for (const part of chunk(payRows, 1000)) await tx.insert(s.payment).values(part);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ store: ctx.storeId, orders: orderRows.length, lines: lineRows.length, payments: payRows.length,
      moneyReconciled: orderRows.every(row => (row.metadata.vendure.chargeProjectionV1 as { status: string }).status === 'exact-header') }, null, 2));
  }

}
