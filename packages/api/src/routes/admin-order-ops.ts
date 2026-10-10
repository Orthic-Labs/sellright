import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { PassThrough, Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { hasUnresolvedPayment } from '../payments/hold.js';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withAdvisoryLock, withStore } from '../db/client.js';
import { withLockedSet, orderIdByCode } from '../db/locks.js';
import * as s from '../db/schema.js';
import { cancelOrderStripeIntents } from '../payments/stripe-reconcile.js';
import { releaseOrderLoyalty } from '../loyalty/ledger.js';
import { dispute } from '../db/schema-ops.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, requireManage, requirePermission, guard } from './admin-helpers.js';
import { calculateOrderTotals } from '../money/totals.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { reserveStockOrThrow, StockReservationError, validateReservableItems } from '../orders/stock-reservation.js';
import { checkPlacement } from '../payments/policy/host.js';
import { PaymentPolicyVetoError } from '../payments/policy/registry.js';
import { purgeBlockedByReservations, purgeReservations } from '../payments/reservation.js';
import { stripeDiscoverable } from '../payments/stripe-reconcile.js';
import { normalizeEmail } from '../auth/email.js';
import { resolveTaxRate } from '../money/tax.js';
import { emitEvent } from '../webhooks/emit.js';
import { enqueueShippingNotification } from '../email/dispatch.js';
import { resolveOrderRecipient } from '../orders/recipient.js';
import { csvCell, orderCode, unitPrice } from './admin-order-utils.js';
import { env } from '../env.js';
import { autoDeliverStore } from '../jobs/auto-deliver.js';
import { fulfillmentStatusSql } from '../orders/status-sql.js';
import {
  DEFAULT_EXPORT_COLUMNS, DEFAULT_LINE_COLUMNS, EXPORT_ROW_CAP, exportCellValues, exportColumnCatalog, fetchExportRows,
  parseExportColumnList, parseExportFilters, parseExportMode, resolveExportColumns,
} from '../orders/export.js';
import {
  IMPORTABLE, classifyTrackingRow, normalizeOrderCode, normalizeTracking, parseTrackingCsv, precheckRow, remainingItems,
  resolveCarrier, suggestOrderCode, type TrackingRowInput, type TrackingStatus,
} from '../orders/tracking-import.js';
import { shippingRate } from '../shipping/calculator.js';
import { variantPriceRuleFromConfig } from '../money/pricing.js';
import { paidOrderEffects, recordSettlementOperation, type SettlementOperation } from '../payments/settlement/record.js';
import { executeEffectsNow } from '../payments/settlement/effects.js';
import { err as logErr } from '../lib/logger.js';
import { onStockChanged } from '../manifest/stock-hook.js';

export const adminOrderOps = new OpenAPIHono();

const BulkResult = z.object({
  results: z.array(z.object({ code: z.string(), ok: z.boolean(), error: z.string().optional() })),
  succeeded: z.number().int(),
  skipped: z.number().int(),
});

// ── draft / manual orders ────────────────────────────────────────────────────
adminOrderOps.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/draft-orders', summary: 'Create a manual order (e.g. phone order)',
    request: { body: { content: J(z.object({
      items: z.array(z.object({ sku: z.string(), quantity: z.number().int().min(1) })).min(1),
      email: z.string().email().optional(),
      shipping: money.optional(), // custom amount; defaults to the chosen method's rate, else 0
      shippingMethodCode: z.string().min(1).optional(), // persisted on the order (code + name snapshot)
      shippingAddress: z.record(z.string(), z.unknown()).optional(),
      markPaid: z.boolean().default(false), // record a manual payment immediately
    })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), state: z.string(), grandTotal: money })) }, 409: { description: 'Unavailable', content: J(z.object({ error: z.string(), skus: z.array(z.string()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const body = c.req.valid('json');
    const items = body.items as Array<{ sku: string; quantity: number }>;
    const skus = [...new Set(items.map((i) => i.sku))];
    // Zero-cache stock rule: true only if a reservation from a transaction that
    // actually commits happened — reset in .catch below, since every path
    // there means the attempt's transaction rolled back.
    let stockChanged = false;
    // PAYMENT-TIMING §3.5: the new order is named before the transaction, so its set is held before any row is written
    // and the inline licence issue (executeEffectsNow below) passes through this set instead of taking L2 after L3.
    const newOrderId = randomUUID();
    const res = await withLockedSet(st.storeId, { kind: 'order', orderId: newOrderId }, async (tx) => {
      const variants = await tx.select().from(s.productVariant).where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)));
      const bySku = new Map(variants.map((v) => [v.sku, v]));
      const blocked = validateReservableItems(items, bySku);
      if (blocked.length) return { kind: 'blocked' as const, skus: blocked };
      stockChanged = await reserveStockOrThrow(tx, st.storeId, items, bySku);
      // Mirror the edit-lines path: resolve the destination tax zone and honour the
      // store's tax-inclusive flag. Omitting taxInclusive here mispriced every
      // tax-inclusive store's manual/phone orders.
      const [storeRow] = await tx.select({ taxRate: s.store.taxRate, taxInclusive: s.store.taxInclusive, shippingTaxable: s.store.shippingTaxable, config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
      if (!storeRow) throw new HttpError(404, 'store not found');
      const priced = items.map((i) => { const v = bySku.get(i.sku)!; return { v, qty: i.quantity, unitPrice: unitPrice(v, variantPriceRuleFromConfig(storeRow.config)) }; });
      const shipCountry = (body.shippingAddress as { country?: string } | null | undefined)?.country ?? null;
      const zones = await tx.select({ countries: s.taxZone.countries, rate: s.taxZone.rate, priority: s.taxZone.priority }).from(s.taxZone).where(eq(s.taxZone.enabled, true));
      const taxRate = resolveTaxRate(zones, shipCountry, storeRow.taxRate);
      let draftMethod: { code: string; name: string; calculator: unknown } | null = null;
      if (body.shippingMethodCode) {
        const [m] = await tx.select().from(s.shippingMethod).where(and(eq(s.shippingMethod.code, body.shippingMethodCode), eq(s.shippingMethod.enabled, true))).limit(1);
        if (!m) throw new HttpError(400, 'unknown shipping method');
        draftMethod = { code: m.code, name: m.name, calculator: m.calculator };
      }
      const draftShipping = body.shipping ?? (draftMethod ? shippingRate(draftMethod.calculator as Parameters<typeof shippingRate>[0]) : 0);
      const totals = calculateOrderTotals({ lines: priced.map((p) => ({ unitPrice: p.unitPrice, quantity: p.qty })), shipping: draftShipping, taxRate, taxInclusive: storeRow.taxInclusive, shippingTaxable: storeRow.shippingTaxable });
      const customerId = body.email ? (await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, normalizeEmail(body.email))).limit(1))[0]?.id ?? null : null;
      const orderId = newOrderId; const code = orderCode();
      const paid = body.markPaid;
      const paidAt = paid ? new Date() : null;
      // Chokepoint operation `order_paid_transition` (order.id): an order created directly in
      // state Paid (markPaid) and its manual payment row are written through
      // recordSettlementOperation; licence issuance follows the same effect as every other Paid
      // transition (idempotent per orderLineId, so a later real settlement will not double-issue).
      // Effects are recorded deferred and executed after the order lines exist.
      // An unpaid draft is its own operation (admin_draft_create): the order.id key of order_paid_transition is
      // reserved for the order's real Paid transition, which a later settlement of this draft must still get.
      // PAYMENT-TIMING §4.6: the placement hook for an admin manual tender (provider 'manual'). A veto refuses the
      // whole request before any row is written. Admin orders hold no reservations (the route takes no upgrade input).
      if (paid) {
        await checkPlacement(tx, st.storeId, { id: orderId, storeId: st.storeId, code, state: 'Paid', currency: st.currency, grandTotal: totals.grandTotal, customerId, metadata: {} }, 'manual')
          .catch((e: unknown) => { if (e instanceof PaymentPolicyVetoError) throw new HttpError(409, e.veto.message); throw e; });
      }
      const draft: Omit<SettlementOperation, 'kind'> = {
        storeId: st.storeId, operationId: orderId, orderId, effectMode: 'deferred' as const,
        mutations: [
          { type: 'order_insert', rows: [{ id: orderId, storeId: st.storeId, code, customerId, state: paid ? 'Paid' : 'PendingPayment', currency: st.currency, subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, placedAt: paidAt, shippingAddress: body.shippingAddress ?? null, shippingMethodCode: draftMethod?.code ?? null, shippingMethodName: draftMethod?.name ?? null }] },
          ...(paid ? [{ type: 'payment_insert' as const, rows: [{ storeId: st.storeId, orderId, amount: totals.grandTotal, method: 'manual', providerRef: `admin-${code}`, state: 'Settled' as const, metadata: { manual: true, by: admin.email } }] }] : []),
        ],
        effects: paid ? paidOrderEffects({ orderId, customerId, paidAt: paidAt ?? new Date(), variant: 'settle', only: 'license_issue' }) : [],
      };
      const settled = paid
        ? await recordSettlementOperation(tx, { ...draft, kind: 'order_paid_transition' })
        : await recordSettlementOperation(tx, { ...draft, kind: 'admin_draft_create' });
      await tx.insert(s.orderLine).values(priced.map((p, idx) => ({ storeId: st.storeId, orderId, variantId: p.v.id, variantSku: p.v.sku, variantName: p.v.name, quantity: p.qty, unitPrice: p.unitPrice, lineSubtotal: totals.lines[idx]!.lineSubtotal, lineDiscount: totals.lines[idx]!.lineDiscount, lineTax: 0, lineTotal: totals.lines[idx]!.lineTotal })));
      await executeEffectsNow(tx, settled.effectIds);
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: orderId, action: 'draft_create', toState: paid ? 'Paid' : 'PendingPayment' });
      return { kind: 'ok' as const, code, state: paid ? 'Paid' : 'PendingPayment', grandTotal: totals.grandTotal };
    }).catch((e: unknown) => {
      stockChanged = false; // the attempt above rolled back — nothing committed
      if (e instanceof StockReservationError) return { kind: 'blocked' as const, skus: e.skus };
      throw e;
    });
    if (stockChanged) onStockChanged(st.slug);
    if (res.kind === 'blocked') return c.json({ error: 'unavailable or out of stock', skus: res.skus }, 409);
    return c.json({ code: res.code, state: res.state, grandTotal: res.grandTotal }, 200);
  }),
);

// ── abandoned carts ──────────────────────────────────────────────────────────
adminOrderOps.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/abandoned-carts', summary: 'Carts not converted to an order',
    request: { query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const where = isNull(s.cart.convertedOrderId);
      const rows = await tx
        .select({
          token: s.cart.token, status: s.cart.status, updatedAt: s.cart.updatedAt, email: sql<string | null>`coalesce(${s.cart.email}, ${s.customer.email})`,
          items: sql<number>`(select coalesce(sum(cl.quantity),0) from cart_line cl where cl.cart_id = ${s.cart.id})::int`,
        })
        .from(s.cart).leftJoin(s.customer, eq(s.customer.id, s.cart.customerId))
        .where(where).orderBy(desc(s.cart.updatedAt)).limit(pageSize).offset((page - 1) * pageSize);
      const cnt = await tx.select({ n: sql<number>`count(*)::int` }).from(s.cart).where(where);
      return { items: rows.filter((r) => r.items > 0).map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })), total: cnt[0]?.n ?? 0, page, pageSize };
    });
    return c.json(out, 200);
  }),
);

// ── order export (CSV + XLSX) ────────────────────────────────────────────────
// Filters, column catalog and the row query live in orders/export.ts; both
// formats share them. Query params: from/to (YYYY-MM-DD), days (fallback),
// state (legacy), status, paymentStatus, fulfillmentStatus, preOrder, trashed,
// paymentMethod, shippingMethod (code or __none__), country, coupon, q, rows=order|line, columns=a,b,c.
// Column order shared by both formats — the default (no `columns` param) set.
export const ORDER_EXPORT_COLUMNS = DEFAULT_EXPORT_COLUMNS;

const exportFiltersFrom = (c: { req: { query: (k: string) => string | undefined } }) => parseExportFilters((k) => c.req.query(k));

adminOrderOps.get('/v1/admin/export/orders/columns', async (c) => {
  try {
    const { admin } = await requireAdmin(c);
    requireStore(admin, c);
    return c.json({ columns: exportColumnCatalog(), defaults: [...DEFAULT_EXPORT_COLUMNS], lineDefaults: [...DEFAULT_LINE_COLUMNS], cap: EXPORT_ROW_CAP }, 200);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// Plain handler (not .openapi) so it can stream text/csv as a download.
adminOrderOps.get('/v1/admin/export/orders', async (c) => {
  try {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const mode = parseExportMode(c.req.query('rows'));
    const cols = resolveExportColumns(parseExportColumnList(c.req.query('columns')), mode);
    const rows = await fetchExportRows(st.storeId, exportFiltersFrom(c), mode);
    const lines = [cols.map((x) => x.key).join(',')];
    for (const r of rows) {
      // Money columns are formatted to 2dp in the CSV, same as the original output.
      const vals = exportCellValues(cols, r, { guard: true });
      lines.push(vals.map((v, i) => csvCell(typeof v === 'number' && cols[i]!.money ? v.toFixed(2) : v)).join(','));
    }
    return c.body(lines.join('\n'), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="orders-${st.slug}.csv"`, 'x-export-rows': String(rows.length), 'x-export-capped': rows.length >= EXPORT_ROW_CAP ? '1' : '0' });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// Same columns/rows as the CSV export above, streamed as a real .xlsx workbook
// (ExcelJS's streaming writer — never buffers the whole file in memory).
adminOrderOps.get('/v1/admin/export/orders.xlsx', async (c) => {
  try {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const mode = parseExportMode(c.req.query('rows'));
    const cols = resolveExportColumns(parseExportColumnList(c.req.query('columns')), mode);
    const rows = await fetchExportRows(st.storeId, exportFiltersFrom(c), mode);

    const passThrough = new PassThrough();
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: passThrough, useStyles: true });
    const sheet = workbook.addWorksheet('Orders');
    sheet.columns = cols.map((x) => ({ header: x.key, key: x.key }));
    for (const r of rows) sheet.addRow(exportCellValues(cols, r, { guard: false })).commit();
    sheet.commit();
    // Fire-and-forget: WorkbookWriter finalizes the ZIP into passThrough as rows
    // are committed; commit() below flushes the remaining central-directory bytes
    // and ends the stream. Do not await before returning — Hono streams the
    // response as passThrough emits, matching the CSV route's download behaviour.
    void workbook.commit();

    const webStream = Readable.toWeb(passThrough) as ReadableStream;
    return c.body(webStream, 200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="orders-${st.slug}.xlsx"`,
      'x-export-rows': String(rows.length), 'x-export-capped': rows.length >= EXPORT_ROW_CAP ? '1' : '0',
    });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// ── tracking import (preview → confirm), open-orders grid feed, history ──────
const TrackingRow = z.object({ code: z.string().max(64), tracking: z.string().max(128), carrier: z.string().max(40).nullish() });
const TrackingBody = z.object({
  rows: z.array(TrackingRow).max(5000).optional(),
  /** Raw pasted/uploaded CSV text; parsed server-side with the same parser the tests cover. */
  csv: z.string().max(2_000_000).optional(),
}).refine((b) => (b.rows?.length ?? 0) > 0 || (b.csv ?? '').trim().length > 0, { message: 'provide rows or csv' });

type PlanTx = Parameters<Parameters<typeof withStore>[1]>[0];
type PlannedRow = {
  index: number; code: string; tracking: string; carrier: string | null; carrierSource: 'given' | 'detected' | 'unknown';
  status: TrackingStatus; message: string; items: Array<{ sku: string; name: string; quantity: number }>;
  suggestion?: string; customerEmail?: string | null;
  // internal (not sent to the client)
  _order?: typeof s.order.$inferSelect; _lines?: Array<typeof s.orderLine.$inferSelect>; _fulfillments?: Array<typeof s.fulfillment.$inferSelect>;
};

async function planTrackingRows(tx: PlanTx, rowsIn: TrackingRowInput[], lock: boolean): Promise<PlannedRow[]> {
  const out: PlannedRow[] = [];
  const seen = new Set<string>();
  let candidates: string[] | null = null;
  for (let index = 0; index < rowsIn.length; index++) {
    const raw = rowsIn[index]!;
    const code = normalizeOrderCode(raw.code);
    const tracking = normalizeTracking(raw.tracking);
    const { carrier, source } = resolveCarrier({ code, tracking, carrier: raw.carrier });
    const base = { index, code, tracking, carrier, carrierSource: source };
    const pre = precheckRow(code, tracking);
    if (pre) { out.push({ ...base, ...pre }); continue; }
    if (seen.has(code)) { out.push({ ...base, status: 'duplicate_in_file', message: 'this order already appears earlier in the file', items: [] }); continue; }
    const q = tx.select().from(s.order).where(sql`upper(${s.order.code}) = ${code}`).limit(1);
    const [o] = await (lock ? q.for('update') : q);
    if (!o) {
      candidates ??= (await tx.select({ code: s.order.code }).from(s.order)
        .where(and(isNull(s.order.deletedAt), inArray(s.order.state, ['Paid', 'PartiallyRefunded'])))
        .orderBy(desc(s.order.createdAt)).limit(5000)).map((r) => r.code);
      const suggestion = suggestOrderCode(code, candidates);
      out.push({ ...base, status: 'unknown_order', message: suggestion ? `no order ${code} — did you mean ${suggestion}?` : 'order not found', items: [], ...(suggestion ? { suggestion } : {}) });
      continue;
    }
    seen.add(code);
    const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
    const fulfillments = await tx.select().from(s.fulfillment).where(and(eq(s.fulfillment.orderId, o.id), sql`${s.fulfillment.state} <> 'Cancelled'`)).orderBy(desc(s.fulfillment.createdAt));
    const verdict = classifyTrackingRow(tracking, {
      state: o.state, deleted: !!o.deletedAt,
      lines: lines.map((l) => ({ sku: l.variantSku, name: l.variantName, quantity: l.quantity, fulfilledQty: l.fulfilledQty, cancelledQty: l.cancelledQty })),
      fulfillments: fulfillments.map((f) => ({ state: f.state, trackingCode: f.trackingCode })),
    });
    // Guests have no customerId: contact email from checkout, else the account email.
    const customerEmail = await resolveOrderRecipient(tx, o);
    out.push({ ...base, ...verdict, code: o.code, customerEmail, _order: o, _lines: lines, _fulfillments: fulfillments });
  }
  return out;
}

const publicRow = ({ _order, _lines, _fulfillments, ...r }: PlannedRow) => r;
const summarize = (rows: PlannedRow[]) => {
  const by: Record<string, number> = {};
  for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1;
  return { total: rows.length, importable: rows.filter((r) => IMPORTABLE.has(r.status)).length, byStatus: by };
};
const rowsFromBody = (b: z.infer<typeof TrackingBody>): TrackingRowInput[] =>
  (b.rows?.length ? b.rows : parseTrackingCsv(b.csv ?? '')).map((r) => ({ code: r.code ?? '', tracking: r.tracking ?? '', carrier: r.carrier }));

const PlannedRowSchema = z.object({
  index: z.number().int(), code: z.string(), tracking: z.string(), carrier: z.string().nullable(), carrierSource: z.enum(['given', 'detected', 'unknown']),
  status: z.string(), message: z.string(), items: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int() })),
  suggestion: z.string().optional(), customerEmail: z.string().nullable().optional(),
});

adminOrderOps.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/import-tracking/preview', summary: 'Dry-run a tracking import (no writes): per-row verdict + items that would ship',
    request: { body: { content: J(TrackingBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ rows: z.array(PlannedRowSchema), summary: z.object({ total: z.number().int(), importable: z.number().int(), byStatus: z.record(z.string(), z.number().int()) }) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const rows = rowsFromBody(c.req.valid('json'));
    if (!rows.length) throw new HttpError(400, 'no rows found');
    if (rows.length > 5000) throw new HttpError(400, 'too many rows (max 5000)');
    const planned = await withStore(st.storeId, (tx) => planTrackingRows(tx, rows, false));
    return c.json({ rows: planned.map(publicRow), summary: summarize(planned) } as never, 200);
  }),
);

adminOrderOps.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/import-tracking', summary: 'Bulk import tracking numbers (creates Shipped fulfillments); only rows that validate are imported',
    request: { body: { content: J(TrackingBody.and(z.object({
      notify: z.boolean().default(true),
      source: z.enum(['paste', 'csv', 'grid']).default('paste'),
      fileName: z.string().max(200).optional(),
    }))) } },
    responses: { 200: { description: 'OK', content: J(z.object({
      updated: z.number().int(), errors: z.array(z.object({ code: z.string(), error: z.string() })),
      emailsQueued: z.number().int(), skipped: z.number().int(), batchId: z.string(), rows: z.array(PlannedRowSchema.extend({ imported: z.boolean() })),
    })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const body = c.req.valid('json');
    const rowsIn = rowsFromBody(body);
    if (!rowsIn.length) throw new HttpError(400, 'no rows found');
    if (rowsIn.length > 5000) throw new HttpError(400, 'too many rows (max 5000)');
    const batchId = randomUUID();
    // One transaction for the whole batch — set true only inside the branch
    // that actually mutates stock (a NEW fulfillment ships un-shipped units).
    let stockChanged = false;
    const result = await withStore(st.storeId, async (tx) => {
      const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
      const storeCtx = { name: st.name, currency: st.currency, config: storeRow?.config ?? null };
      // Re-plan under row locks: the preview was a snapshot, this is the truth.
      const planned = await planTrackingRows(tx, rowsIn, true);
      let updated = 0; let emailsQueued = 0;
      const imported = new Set<number>();
      for (const row of planned) {
        if (!IMPORTABLE.has(row.status) || !row._order) continue;
        const o = row._order;
        let fulfillmentId: string;
        let dedupe = `shipping_notification:${o.id}:Shipped`;
        const shipNow = (row._lines ?? []).map((l) => ({ l, ship: l.quantity - l.fulfilledQty - l.cancelledQty })).filter((x) => x.ship > 0);
        if (row.status === 'ready' && shipNow.length > 0) {
          const [f] = await tx.insert(s.fulfillment).values({ storeId: st.storeId, orderId: o.id, state: 'Shipped', trackingCode: row.tracking, carrier: row.carrier, notifyCustomer: body.notify }).returning({ id: s.fulfillment.id });
          fulfillmentId = f!.id;
          dedupe = `shipping_notification:${fulfillmentId}:Shipped`;
          await tx.insert(s.fulfillmentLine).values(shipNow.map(({ l, ship }) => ({ storeId: st.storeId, fulfillmentId, orderLineId: l.id, quantity: ship })));
          for (const { l, ship } of shipNow) {
            await tx.update(s.orderLine).set({ fulfilledQty: l.quantity - l.cancelledQty }).where(eq(s.orderLine.id, l.id));
            if (l.variantId) {
              await tx.update(s.stock).set({ onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`, allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)` }).where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
              await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: o.id, actor: admin.email });
              stockChanged = true;
            }
          }
        } else {
          // Pending fulfillment -> Shipped, or a tracking-number correction on a Shipped one.
          const target = (row._fulfillments ?? []).find((f) => (row.status === 'ready' ? f.state === 'Pending' : f.state === 'Shipped'));
          if (!target) continue;
          fulfillmentId = target.id;
          await tx.update(s.fulfillment).set({ state: 'Shipped', trackingCode: row.tracking, carrier: row.carrier, updatedAt: new Date() }).where(eq(s.fulfillment.id, target.id));
        }
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'tracking_import', toState: 'Shipped', data: { tracking: row.tracking, carrier: row.carrier, batchId, fulfillmentId, notify: body.notify } });
        // WP2: emit order.shipped (same txn => atomic with the Shipped transition).
        await emitEvent(tx, st.storeId, 'order.shipped', { code: o.code, trackingCode: row.tracking, carrier: row.carrier });
        // SR-05/SR-12: durable outbox send inside the same txn — never an inline post-commit send.
        if (body.notify && row.customerEmail) {
          const queued = await enqueueShippingNotification(tx, st.storeId, storeCtx, row.customerEmail, { code: o.code, trackingCode: row.tracking, carrier: row.carrier, dedupeKey: dedupe });
          if (queued) emailsQueued++;
        }
        imported.add(row.index);
        updated++;
      }
      const skipped = planned.length - updated;
      const errors = planned.filter((r) => !imported.has(r.index)).map((r) => ({ code: r.code || '(blank)', error: r.message }));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'tracking_import', entityId: batchId, action: 'batch', data: { source: body.source, fileName: body.fileName ?? null, total: planned.length, shipped: updated, skipped, emailsQueued, notify: body.notify, errors: errors.slice(0, 50) } });
      return { updated, errors, emailsQueued, skipped, rows: planned.map((r) => ({ ...publicRow(r), imported: imported.has(r.index) })) };
    });
    if (stockChanged) onStockChanged(st.slug);
    return c.json({ ...result, batchId } as never, 200);
  }),
);

adminOrderOps.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/import-tracking/recent', summary: 'Recent tracking imports',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) => {
      const rows = await tx.select().from(s.auditLog).where(and(eq(s.auditLog.entity, 'tracking_import'), eq(s.auditLog.action, 'batch'))).orderBy(desc(s.auditLog.at)).limit(20);
      return rows.map((r) => ({ id: r.entityId, at: r.at.toISOString(), actor: r.actor, ...(r.data as Record<string, unknown>) }));
    });
    return c.json({ items }, 200);
  }),
);

// Feed for the manual tracking grid: paid orders that still have items to ship,
// oldest first, with the remaining items per order. NOT under /orders/{code}'s
// namespace so it can never be shadowed by the order-detail route.
adminOrderOps.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/fulfillment/open-orders', summary: 'Paid orders awaiting shipment (unfulfilled or partially fulfilled)',
    request: { query: z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) },
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()), total: z.number().int() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { q, limit } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const where = sql`"order"."deleted_at" is null and "order"."state" in ('Paid','PartiallyRefunded') and ${fulfillmentStatusSql()} in ('unfulfilled','partially_fulfilled')${q ? sql` and ("order"."code" ilike ${`%${q}%`} or cust.email ilike ${`%${q}%`})` : sql``}`;
      const r = await tx.execute(sql`
        select "order"."id" as id, "order"."code" as code, "order"."placed_at" as placed_at, "order"."created_at" as created_at, "order"."is_pre_order" as is_pre_order,
          cust.email as email, nullif(trim(coalesce(cust.first_name, '') || ' ' || coalesce(cust.last_name, '')), '') as name,
          "order"."shipping_address"->>'country' as country, ${fulfillmentStatusSql()} as fulfillment_status
        from "order" left join customer cust on cust.id = "order"."customer_id"
        where ${where}
        order by coalesce("order"."placed_at", "order"."created_at") asc, "order"."code"
        limit ${limit}`);
      const orders = (r as unknown as { rows: Array<{ id: string; code: string; placed_at: Date | null; created_at: Date; is_pre_order: boolean; email: string | null; name: string | null; country: string | null; fulfillment_status: string }> }).rows;
      const [cnt] = (await tx.execute(sql`select count(*)::int as n from "order" left join customer cust on cust.id = "order"."customer_id" where ${where}`) as unknown as { rows: Array<{ n: number }> }).rows;
      const ids = orders.map((o) => o.id);
      const lines = ids.length ? await tx.select().from(s.orderLine).where(inArray(s.orderLine.orderId, ids)) : [];
      const ful = ids.length ? await tx.select({ orderId: s.fulfillment.orderId, trackingCode: s.fulfillment.trackingCode, state: s.fulfillment.state }).from(s.fulfillment).where(and(inArray(s.fulfillment.orderId, ids), sql`${s.fulfillment.state} <> 'Cancelled'`)) : [];
      return {
        total: cnt?.n ?? 0,
        items: orders.map((o) => ({
          code: o.code, placedAt: new Date(o.placed_at ?? o.created_at).toISOString(), isPreOrder: o.is_pre_order, email: o.email, name: o.name, country: o.country, fulfillmentStatus: o.fulfillment_status,
          items: remainingItems(lines.filter((l) => l.orderId === o.id).map((l) => ({ sku: l.variantSku, name: l.variantName, quantity: l.quantity, fulfilledQty: l.fulfilledQty, cancelledQty: l.cancelledQty }))),
          shippedTracking: ful.filter((f) => f.orderId === o.id && f.trackingCode).map((f) => f.trackingCode),
        })),
      };
    });
    return c.json(out, 200);
  }),
);

// ── Auto-Delivered: run now, with dry-run preview (DD order-tools parity) ────
adminOrderOps.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/jobs/auto-deliver', summary: 'Mark old Shipped fulfillments as Delivered (dry-run by default)',
    request: { body: { content: J(z.object({ dryRun: z.boolean().default(true), days: z.number().int().min(1).max(365).optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({
      dryRun: z.boolean(), days: z.number().int(), cutoff: z.string(), count: z.number().int(),
      sample: z.array(z.object({ code: z.string(), trackingCode: z.string().nullable(), carrier: z.string().nullable(), shippedAt: z.string() })),
    })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { dryRun, days: reqDays } = c.req.valid('json');
    const days = reqDays ?? env.JOBS_AUTO_DELIVER_DAYS ?? 10;
    const r = await autoDeliverStore(st.storeId, { apply: !dryRun, days, exact: dryRun, maxBatches: dryRun ? 1 : 25 });
    if (!dryRun) {
      await withStore(st.storeId, (tx) => tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'store', entityId: st.storeId, action: 'auto_deliver_run', data: { days, delivered: r.count } }));
    }
    return c.json({ dryRun, days, cutoff: r.cutoff, count: r.count, sample: r.sample }, 200);
  }),
);

// ── bulk order management: cancel / soft-delete (trash) / restore / purge ──────
// All four mirror bulk-fulfill: dedup codes → per-order withStore → one result
// row each → { results, succeeded, skipped }. One bad order never fails the batch.

// ── bulk cancel (unpaid orders only — releases stock; paid orders are skipped,
//    use Refund for those so money is handled explicitly) ──────────────────────
adminOrderOps.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/bulk-cancel', summary: 'Cancel multiple unpaid orders (release stock)',
    request: { body: { content: J(z.object({ codes: z.array(z.string().min(1)).min(1).max(100) })) } },
    responses: { 200: { description: 'OK', content: J(BulkResult) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requirePermission(st, 'cancel_orders');
    const { codes } = c.req.valid('json');
    const results: { code: string; ok: boolean; error?: string }[] = [];
    for (const code of [...new Set(codes)] as string[]) {
      // Fresh per iteration — each code is its own committed transaction.
      let stockChanged = false;
      const preId = await orderIdByCode(st.storeId, code);
      // X-46: L0 pay advisory per order (one at a time, never nested across codes), before its lock set.
      const r = !preId ? { ok: false as const, error: 'order not found' } : await withAdvisoryLock(`pay:${st.storeId}:${code}`, () => withLockedSet(st.storeId, { kind: 'order', orderId: preId }, async (tx): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> => {
        const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
        if (!o) return { ok: false, error: 'order not found' };
        if (await hasUnresolvedPayment(tx, o.id)) return { ok: false, error: 'Resolve the pending payment before cancelling' };
        if (o.state === 'Cancelled') return { ok: false, error: 'already cancelled' };
        if (o.state !== 'PendingPayment') return { ok: false, error: `paid order — use Refund (state ${o.state})` };
        if (!canTransition(o.state as OrderState, 'Cancelled')) return { ok: false, error: `cannot cancel from ${o.state}` };
        const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
        for (const l of lines) {
          const rel = l.quantity - l.fulfilledQty - l.cancelledQty;
          if (rel > 0) {
            // D6: mark released units cancelled so a later refund can't release them again.
            await tx.update(s.orderLine).set({ cancelledQty: sql`${s.orderLine.cancelledQty} + ${rel}` }).where(eq(s.orderLine.id, l.id));
          }
          if (rel > 0 && l.variantId) {
            await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${rel}, 0)` })
              .where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
            stockChanged = true;
          }
        }
        await tx.update(s.order).set({ state: 'Cancelled', updatedAt: new Date() }).where(eq(s.order.id, o.id));
        // LOYALTY-1: release points reserved by this order (idempotent).
        await releaseOrderLoyalty(tx, st.storeId, o.id, admin.email);
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'cancel', fromState: o.state, toState: 'Cancelled' });
        return { ok: true, orderId: o.id };
      }));
      if (stockChanged) onStockChanged(st.slug);
      // After commit: cancel the order's open Stripe intents (best-effort, audited).
      if (r.ok) await cancelOrderStripeIntents(st.storeId, r.orderId, admin.email);
      results.push(r.ok ? { code, ok: true } : { code, ok: false, error: r.error });
    }
    const succeeded = results.filter((r) => r.ok).length;
    return c.json({ results, succeeded, skipped: results.length - succeeded }, 200);
  }),
);

// ── soft-delete (trash) / restore — reversible "remove from my view" ──────────
adminOrderOps.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/bulk-soft-delete', summary: 'Move orders to trash (reversible)',
    request: { body: { content: J(z.object({ codes: z.array(z.string().min(1)).min(1).max(100) })) } },
    responses: { 200: { description: 'OK', content: J(BulkResult) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { codes } = c.req.valid('json');
    const results: { code: string; ok: boolean; error?: string }[] = [];
    for (const code of [...new Set(codes)] as string[]) {
      const r = await withStore(st.storeId, async (tx): Promise<{ ok: true } | { ok: false; error: string }> => {
        const [o] = await tx.select({ id: s.order.id, deletedAt: s.order.deletedAt }).from(s.order).where(eq(s.order.code, code)).limit(1);
        if (!o) return { ok: false, error: 'order not found' };
        if (o.deletedAt) return { ok: false, error: 'already trashed' };
        await tx.update(s.order).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(s.order.id, o.id));
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'soft_delete' });
        return { ok: true };
      });
      results.push(r.ok ? { code, ok: true } : { code, ok: false, error: r.error });
    }
    const succeeded = results.filter((r) => r.ok).length;
    return c.json({ results, succeeded, skipped: results.length - succeeded }, 200);
  }),
);

adminOrderOps.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/bulk-restore', summary: 'Restore orders from trash',
    request: { body: { content: J(z.object({ codes: z.array(z.string().min(1)).min(1).max(100) })) } },
    responses: { 200: { description: 'OK', content: J(BulkResult) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { codes } = c.req.valid('json');
    const results: { code: string; ok: boolean; error?: string }[] = [];
    for (const code of [...new Set(codes)] as string[]) {
      const r = await withStore(st.storeId, async (tx): Promise<{ ok: true } | { ok: false; error: string }> => {
        const [o] = await tx.select({ id: s.order.id, deletedAt: s.order.deletedAt }).from(s.order).where(eq(s.order.code, code)).limit(1);
        if (!o) return { ok: false, error: 'order not found' };
        if (!o.deletedAt) return { ok: false, error: 'not trashed' };
        await tx.update(s.order).set({ deletedAt: null, updatedAt: new Date() }).where(eq(s.order.id, o.id));
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'restore' });
        return { ok: true };
      });
      results.push(r.ok ? { code, ok: true } : { code, ok: false, error: r.error });
    }
    const succeeded = results.filter((r) => r.ok).length;
    return c.json({ results, succeeded, skipped: results.length - succeeded }, 200);
  }),
);

// ── purge (permanent) — only trashed orders; paid orders need force + reason.
//    Cascade order (children first): refund_line→refund, fulfillment_line→
//    fulfillment, return_line→return_request, license_activation→license,
//    promotion_usage, payment, order_line, order. The txn rolls back on any
//    error, so a wrong cascade fails the purge safely (no partial deletion). ────
adminOrderOps.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/bulk-purge', summary: 'Permanently delete trashed orders (cascade)',
    // Purge is the heavy op (cascade per order) — cap at 50 (vs 100 for the cheap
    // ops) so one request can't hold locks too long. `reason` is trimmed + non-empty.
    request: { body: { content: J(z.object({ codes: z.array(z.string().min(1)).min(1).max(50), force: z.boolean().default(false), reason: z.string().trim().min(1).optional() })) } },
    responses: { 200: { description: 'OK', content: J(BulkResult) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { codes, force, reason } = c.req.valid('json');
    const results: { code: string; ok: boolean; error?: string }[] = [];
    // PAYMENT-TIMING §3.5: the Stripe discovery flag is evaluated before any transaction (no I/O inside one).
    const [purgeStore] = await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const stripeDiscover = await stripeDiscoverable(st.storeId, purgeStore?.config ?? {});
    for (const code of [...new Set(codes)] as string[]) {
      const preId = await orderIdByCode(st.storeId, code);
      const r = !preId ? { ok: false as const, error: 'order not found' } : await withLockedSet(st.storeId, { kind: 'order', orderId: preId }, async (tx, held): Promise<{ ok: true } | { ok: false; error: string }> => {
        const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
        if (!o) return { ok: false, error: 'order not found' };
        if (!o.deletedAt) return { ok: false, error: 'trash the order first (purge only removes trashed orders)' };
        if (await hasUnresolvedPayment(tx, o.id)) return { ok: false, error: 'Resolve the pending payment before purging' };
        if (await purgeBlockedByReservations(tx, st.storeId, o.id, { stripeDiscoverable: stripeDiscover })) return { ok: false, error: 'Resolve the pending payment before purging' };
        const isPaid = o.state === 'Paid' || o.state === 'PartiallyRefunded' || o.state === 'Refunded';
        if (isPaid && !force) return { ok: false, error: `paid order — purge requires force + reason (state ${o.state})` };
        if (isPaid && force && !reason) return { ok: false, error: 'force-purging a paid order requires a reason' };

        // Audit BEFORE the cascade so the record survives the row deletion.
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'purge', data: { code, state: o.state, force, reason: reason ?? null } });

        const refunds = await tx.select({ id: s.refund.id }).from(s.refund).where(eq(s.refund.orderId, o.id));
        if (refunds.length) await tx.delete(s.refundLine).where(inArray(s.refundLine.refundId, refunds.map((x) => x.id)));
        await tx.delete(s.refund).where(eq(s.refund.orderId, o.id));

        const fulfillments = await tx.select({ id: s.fulfillment.id }).from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id));
        if (fulfillments.length) await tx.delete(s.fulfillmentLine).where(inArray(s.fulfillmentLine.fulfillmentId, fulfillments.map((x) => x.id)));
        await tx.delete(s.fulfillment).where(eq(s.fulfillment.orderId, o.id));

        const returns = await tx.select({ id: s.returnRequest.id }).from(s.returnRequest).where(eq(s.returnRequest.orderId, o.id));
        if (returns.length) await tx.delete(s.returnLine).where(inArray(s.returnLine.returnId, returns.map((x) => x.id)));
        await tx.delete(s.returnRequest).where(eq(s.returnRequest.orderId, o.id));

        const lics = await tx.select({ id: s.license.id }).from(s.license).where(eq(s.license.orderId, o.id));
        if (lics.length) {
          await tx.delete(s.licenseActivation).where(inArray(s.licenseActivation.licenseId, lics.map((x) => x.id)));
          await tx.delete(s.license).where(inArray(s.license.id, lics.map((x) => x.id)));
        }
        // gift_card_transaction + return_request also reference order; gift-card
        // txns are a money ledger we keep, but they FK order — null is allowed via
        // the optional reference, so detach them rather than delete the audit trail.
        await tx.delete(s.promotionUsage).where(eq(s.promotionUsage.orderId, o.id));
        // Order editing (G13): edit history + adjustments (also ON DELETE cascade in 0084).
        await tx.delete(s.orderEdit).where(eq(s.orderEdit.orderId, o.id));
        await tx.delete(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, o.id));
        // Payment reservations (PAYMENT-TIMING): deleted before the order; the lock set already holds them (L4).
        await purgeReservations(tx, held, { storeId: st.storeId, orderId: o.id });
        await tx.update(s.giftCardTransaction).set({ orderId: null }).where(eq(s.giftCardTransaction.orderId, o.id));
        await tx.update(s.stockMovement).set({ refOrderId: null }).where(eq(s.stockMovement.refOrderId, o.id));
        // A converted cart points back at this order (nullable FK) — detach it so
        // the order row can be deleted (the cart row itself is analytics, kept).
        await tx.update(s.cart).set({ convertedOrderId: null }).where(eq(s.cart.convertedOrderId, o.id));
        // A subscription's backing order (nullable FK) — detach so the order can be
        // purged; the subscription row (Stripe link) is kept.
        await tx.update(s.subscription).set({ orderId: null }).where(eq(s.subscription.orderId, o.id));
        // Dispute rows are an operator/compliance ledger — dispute.order_id and
        // dispute.payment_id are nullable back-refs, so detach rather than delete
        // the dispute record itself (a chargeback must survive order purge).
        await tx.update(dispute).set({ orderId: null }).where(eq(dispute.orderId, o.id));
        const pays = await tx.select({ id: s.payment.id }).from(s.payment).where(eq(s.payment.orderId, o.id));
        if (pays.length) await tx.update(dispute).set({ paymentId: null })
          .where(inArray(dispute.paymentId, pays.map((p) => p.id)));
        const attempts = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, o.id));
        if (attempts.length) await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email,
          entity: 'order', entityId: o.id, action: 'archive_payment_attempts', data: { attempts } });
        await tx.delete(s.paymentAttempt).where(eq(s.paymentAttempt.orderId, o.id));
        await tx.delete(s.orderLine).where(eq(s.orderLine.orderId, o.id));
        // Chokepoint operation `order_purge` (order.id): the order's payments are snapshotted on the
        // operation row first (so invoice evidence survives), then payment rows and the order row go.
        await recordSettlementOperation(tx, {
          storeId: st.storeId, kind: 'order_purge', operationId: o.id, effects: [],
          mutations: [{ type: 'order_purge', orderId: o.id }],
        });
        return { ok: true };
      });
      results.push(r.ok ? { code, ok: true } : { code, ok: false, error: r.error });
    }
    const succeeded = results.filter((r) => r.ok).length;
    return c.json({ results, succeeded, skipped: results.length - succeeded }, 200);
  }),
);

