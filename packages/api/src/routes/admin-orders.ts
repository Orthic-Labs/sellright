import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, requireManage, guard } from './admin-helpers.js';
import { calculateOrderTotals } from '../money/totals.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { reserveStockOrThrow, StockReservationError, validateReservableItems } from '../orders/stock-reservation.js';
import { normalizeEmail } from '../auth/email.js';
import { buildInvoice, buildPackingSlip, renderInvoiceHtml } from '../orders/invoice.js';
import { evaluateCoupon } from '../money/coupon.js';
import { resolveTaxRate } from '../money/tax.js';
import { emitEvent } from '../webhooks/emit.js';
import { sendShippingNotification } from '../email/dispatch.js';
import { getProvider } from '../payments/provider.js';
import { stripeModeFromConfig } from '../payments/stripe.js';

export const adminOrders = new OpenAPIHono();

// Shared result shape for the bulk order operations (cancel / soft-delete /
// restore / purge): a per-order outcome row + succeeded/skipped totals, so the
// admin renders an "X succeeded, Y skipped" panel (mirrors bulk-fulfill).
const BulkResult = z.object({
  results: z.array(z.object({ code: z.string(), ok: z.boolean(), error: z.string().optional() })),
  succeeded: z.number().int(),
  skipped: z.number().int(),
});

// ── invoice + packing slip (printable order documents) ────────────────────────
async function loadOrderForDoc(storeId: string, code: string) {
  return withStore(storeId, async (tx) => {
    const [order] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
    if (!order) return null;
    const lines = await tx
      .select({ variantSku: s.orderLine.variantSku, variantName: s.orderLine.variantName, quantity: s.orderLine.quantity, unitPrice: s.orderLine.unitPrice, lineTotal: s.orderLine.lineTotal })
      .from(s.orderLine)
      .where(eq(s.orderLine.orderId, order.id));
    const [storeRow] = await tx.select({ name: s.store.name, slug: s.store.slug }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    return { order, lines, store: { name: storeRow?.name ?? 'Store', slug: storeRow?.slug ?? '' } };
  });
}

adminOrders.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders/{code}/invoice', summary: 'Order invoice (json or ?format=html)',
    request: { params: z.object({ code: z.string() }), query: z.object({ format: z.enum(['json', 'html']).default('json') }) },
    responses: { 200: { description: 'Invoice', content: { 'application/json': { schema: z.any() }, 'text/html': { schema: z.string() } } }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { code } = c.req.valid('param');
    const { format } = c.req.valid('query');
    const data = await loadOrderForDoc(st.storeId, code);
    if (!data) throw new HttpError(404, 'order not found');
    
    const doc = buildInvoice(data.order as never, data.lines, data.store);
    if (format === 'html') return c.html(renderInvoiceHtml(doc));
    return c.json(doc, 200);
  }),
);

adminOrders.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders/{code}/packing-slip', summary: 'Order packing slip',
    request: { params: z.object({ code: z.string() }) },
    responses: { 200: { description: 'Packing slip', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { code } = c.req.valid('param');
    const data = await loadOrderForDoc(st.storeId, code);
    if (!data) throw new HttpError(404, 'order not found');
    
    return c.json(buildPackingSlip(data.order as never, data.lines, data.store), 200);
  }),
);

// ── order editing (unpaid orders only — no gateway adjustment needed) ─────────
adminOrders.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/orders/{code}/lines', summary: 'Edit lines of an unpaid order (re-reserve stock + recompute totals)',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ lines: z.array(z.object({ sku: z.string(), quantity: z.number().int().min(1) })).min(1) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), grandTotal: money })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Bad state / stock', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { code } = c.req.valid('param');
    const body = c.req.valid('json');
    const reqLines: Array<{ sku: string; quantity: number }> = body.lines;
    type R = { kind: 'ok'; grandTotal: number } | { kind: 'notfound' } | { kind: 'badstate'; state: string } | { kind: 'blocked'; skus: string[] };
    const res: R = await withStore(st.storeId, async (tx): Promise<R> => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return { kind: 'notfound' };
      if (o.state !== 'PendingPayment') return { kind: 'badstate', state: o.state };

      // Release the order's current allocations, then re-reserve the new set
      // (throws → whole txn rolls back, leaving the order + stock untouched).
      const oldLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      for (const l of oldLines) {
        const rel = l.quantity - l.fulfilledQty;
        if (rel > 0 && l.variantId) {
          await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${rel}, 0)` }).where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
        }
      }
      const skus = [...new Set(reqLines.map((i) => i.sku))];
      const variants = await tx.select().from(s.productVariant).where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)));
      const bySku = new Map(variants.map((v) => [v.sku, v]));
      const blocked = validateReservableItems(reqLines, bySku);
      if (blocked.length) throw new StockReservationError(blocked);
      await reserveStockOrThrow(tx, st.storeId, reqLines, bySku);

      const priced = reqLines.map((i) => { const v = bySku.get(i.sku)!; return { v, qty: i.quantity, unitPrice: unitPrice(v) }; });
      const subtotalCents = priced.reduce((a, p) => a + p.unitPrice * p.qty, 0);
      const [storeRow] = await tx.select({ taxRate: s.store.taxRate, taxInclusive: s.store.taxInclusive, shippingTaxable: s.store.shippingTaxable }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
      const shipCountry = (o.shippingAddress as { country?: string } | null)?.country ?? null;
      const zones = await tx.select({ countries: s.taxZone.countries, rate: s.taxZone.rate, priority: s.taxZone.priority }).from(s.taxZone).where(eq(s.taxZone.enabled, true));
      const taxRate = resolveTaxRate(zones, shipCountry, storeRow!.taxRate);

      // Keep the order's existing promotion applied, recomputed on the new subtotal.
      let promotion;
      if (o.promotionId) {
        const [promo] = await tx.select().from(s.promotion).where(eq(s.promotion.id, o.promotionId)).limit(1);
        if (promo) { const ev = evaluateCoupon({ type: promo.type, value: promo.value, conditions: promo.conditions }, { subtotal: subtotalCents, activeVerifications: [] }); if (ev.valid && ev.promotion) promotion = ev.promotion; }
      }
      const totals = calculateOrderTotals({ lines: priced.map((p) => ({ unitPrice: p.unitPrice, quantity: p.qty })), shipping: o.shippingTotal, taxRate, taxInclusive: storeRow!.taxInclusive, shippingTaxable: storeRow!.shippingTaxable, promotion });

      await tx.delete(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      await tx.insert(s.orderLine).values(priced.map((p, idx) => ({
        storeId: st.storeId, orderId: o.id, variantId: p.v.id, variantSku: p.v.sku, variantName: p.v.name,
        quantity: p.qty, unitPrice: p.unitPrice, lineSubtotal: totals.lines[idx]!.lineSubtotal, lineDiscount: totals.lines[idx]!.lineDiscount, lineTax: 0, lineTotal: totals.lines[idx]!.lineTotal,
      })));
      await tx.update(s.order).set({ subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, updatedAt: new Date() }).where(eq(s.order.id, o.id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'edit_lines', data: { grandTotal: totals.grandTotal, lines: priced.length } });
      return { kind: 'ok', grandTotal: totals.grandTotal };
    }).catch((e: unknown): R => { if (e instanceof StockReservationError) return { kind: 'blocked', skus: e.skus }; throw e; });

    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `only unpaid (PendingPayment) orders can be edited — this one is ${res.state}`);
    if (res.kind === 'blocked') return c.json({ error: 'insufficient stock', skus: res.skus }, 409);
    return c.json({ code, grandTotal: res.grandTotal }, 200);
  }),
);

const orderCode = () => ('SR' + randomUUID().replace(/-/g, '').slice(0, 10)).toUpperCase();

/** Infer carrier from a tracking number shape (USPS/UPS/FedEx) — matches the DD
 *  order-tools heuristic. Returns null if unknown. */
function inferCarrier(t: string): string | null {
  const x = t.replace(/\s/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(x)) return 'UPS';
  if (/^(94|93|92|95|420)\d{20,}$/.test(x) || /^[A-Z]{2}\d{9}US$/.test(x)) return 'USPS';
  if (/^\d{12}$/.test(x) || /^\d{15}$/.test(x) || /^\d{20,22}$/.test(x)) return 'FedEx';
  return null;
}
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function unitPrice(v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }): number {
  if (v.isPreOrder && v.preOrderPrice != null) return v.preOrderPrice;
  if (v.salePrice != null) return v.salePrice;
  return v.price;
}

// ── refunds ──────────────────────────────────────────────────────────────────
adminOrders.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/refund', summary: 'Refund an order (full or partial, optional restock)',
    request: {
      params: z.object({ code: z.string() }),
      body: { content: J(z.object({
        lines: z.array(z.object({ orderLineId: z.string(), quantity: z.number().int().min(1) })).optional(),
        amount: money.optional(), // override; else computed from lines or full remaining
        restock: z.boolean().default(false),
        reason: z.string().optional(),
      })) },
    },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), state: z.string(), refunded: money })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { code } = c.req.valid('param');
    const body = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      // FOR UPDATE: lock the order so two concurrent refund requests can't both
      // read the same priorRefunded and both pass the balance check (over-refund).
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
      if (!o) return { kind: 'notfound' as const };
      if (o.state !== 'Paid' && o.state !== 'PartiallyRefunded') return { kind: 'badstate' as const, state: o.state };
      const [pay] = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, o.id), eq(s.payment.state, 'Settled'))).orderBy(desc(s.payment.createdAt)).limit(1);
      if (!pay) return { kind: 'nopayment' as const };
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      const byId = new Map(lines.map((l) => [l.id, l]));

      // Determine amount + which lines/qty.
      const reqLines = (body.lines ?? []) as Array<{ orderLineId: string; quantity: number }>;
      const refundLines = reqLines.map((rl) => ({ ...rl, line: byId.get(rl.orderLineId) })).filter((x) => x.line);
      let amount = body.amount ?? 0;
      if (body.amount == null) {
        if (refundLines.length) amount = refundLines.reduce((a, x) => a + Math.round((x.line!.lineTotal / x.line!.quantity) * x.quantity), 0);
        else amount = o.grandTotal - (await alreadyRefunded(tx, o.id)); // full remaining
      }
      const priorRefunded = await alreadyRefunded(tx, o.id);
      if (amount <= 0 || amount > o.grandTotal - priorRefunded) return { kind: 'badamount' as const, max: o.grandTotal - priorRefunded };

      // ra-022: check the target state transition is valid BEFORE writing any
      // ledger rows — an invalid transition returns badstate so the txn rolls
      // back with no orphan refund row.
      const totalRefunded = priorRefunded + amount;
      const newState: OrderState = totalRefunded >= o.grandTotal ? 'Refunded' : 'PartiallyRefunded';
      if (!canTransition(o.state as OrderState, newState)) return { kind: 'badstate' as const, state: o.state };

      // WP3: reverse the money at the gateway BEFORE writing the ledger row, so a
      // gateway failure aborts the whole refund (txn rolls back, no orphan ledger
      // row). manual/cod refundPayment is a no-op Settled; stripe actually refunds.
      let gatewayResult: { state: 'Settled' | 'Pending'; providerRef: string | null };
      try {
        gatewayResult = await executeGatewayRefund(tx, st.storeId, pay.method, pay.providerRef, amount, o.currency);
      } catch (e: unknown) {
        const err = e as { kind?: string; message?: string };
        if (err.kind === 'providerfail') return { kind: 'providerfail' as const, message: err.message ?? 'gateway refund failed' };
        throw e;
      }

      const [refund] = await tx.insert(s.refund).values({ storeId: st.storeId, paymentId: pay.id, orderId: o.id, amount, reason: body.reason ?? null, state: gatewayResult.state, providerRef: gatewayResult.providerRef }).returning({ id: s.refund.id });
      for (const x of refundLines) {
        await tx.insert(s.refundLine).values({ storeId: st.storeId, refundId: refund!.id, orderLineId: x.line!.id, quantity: x.quantity, amount: Math.round((x.line!.lineTotal / x.line!.quantity) * x.quantity), restock: body.restock });
        await tx.update(s.orderLine).set({ refundedQty: Math.min(x.line!.quantity, x.line!.refundedQty + x.quantity) }).where(eq(s.orderLine.id, x.line!.id));
        if (body.restock && x.line!.variantId) {
          await tx.update(s.stock).set({ onHand: sql`${s.stock.onHand} + ${x.quantity}` }).where(and(eq(s.stock.variantId, x.line!.variantId), eq(s.stock.storeId, st.storeId)));
          await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: x.line!.variantId, delta: x.quantity, reason: 'refund_restock', refOrderId: o.id });
        }
      }
      await tx.update(s.order).set({ state: newState, updatedAt: new Date() }).where(eq(s.order.id, o.id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'refund', fromState: o.state, toState: newState, data: { amount, restock: body.restock } });
      await emitEvent(tx, st.storeId, 'order.refunded', { code: o.code, amount, state: newState });
      return { kind: 'ok' as const, state: newState, refunded: amount };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `order not refundable in state ${res.state} — transition to Refunded/PartiallyRefunded not allowed`);
    if (res.kind === 'nopayment') throw new HttpError(409, 'no settled payment to refund');
    if (res.kind === 'badamount') throw new HttpError(409, `refund amount must be 1..${res.max} cents`);
    if (res.kind === 'providerfail') throw new HttpError(502, res.message);
    return c.json({ code, state: res.state, refunded: res.refunded }, 200);
  }),
);

async function alreadyRefunded(tx: Tx, orderId: string): Promise<number> {
  // Drizzle's typed query builder — no `as any`. `tx` is the withStore() txn
  // handle and exposes the same `select({...}).from(...).where(...)` shape.
  // Exclude Failed refunds — a failed gateway reversal returned no money, so it
  // must not count against the order's refundable balance (over-blocks otherwise).
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(${s.refund.amount}),0)::int` }).from(s.refund).where(and(eq(s.refund.orderId, orderId), sql`${s.refund.state} <> 'Failed'`));
  return r?.n ?? 0;
}

/**
 * Calls the payment gateway to execute the monetary refund and returns the
 * provider-resolved state + ref. For manual/cod (no provider.refundPayment)
 * this is a no-op that returns { state: 'Settled', providerRef: null }.
 *
 * Throws { kind: 'providerfail', message } on gateway failure so the caller
 * can exit the withStore() txn cleanly without writing any ledger rows.
 */
async function executeGatewayRefund(
  tx: Tx,
  storeId: string,
  payMethod: string,
  payProviderRef: string | null,
  amount: number,
  currency: string,
): Promise<{ state: 'Settled' | 'Pending'; providerRef: string | null }> {
  const provider = getProvider(payMethod);
  if (!provider?.refundPayment) {
    return { state: 'Settled', providerRef: null };
  }
  let stripeMode: 'test' | 'live' | undefined;
  if (payMethod === 'stripe') {
    const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    stripeMode = stripeModeFromConfig(row?.config);
  }
  const r = await provider.refundPayment({ providerRef: payProviderRef, amount, currency, stripeMode });
  if (r.state === 'Failed') {
    throw Object.assign(new Error(r.errorMessage ?? 'gateway refund failed'), { kind: 'providerfail' as const, message: r.errorMessage ?? 'gateway refund failed' });
  }
  return { state: r.state as 'Settled' | 'Pending', providerRef: r.providerRef };
}

// ── returns / exchanges (RMA) ─────────────────────────────────────────────────
// Create a request, then approve (restock + record a refund via the existing
// refund machinery) or reject. Gateway refund is payment-blocked; this records
// the ledger refund + restock, same as the manual refund endpoint.
adminOrders.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/returns', summary: 'Open a return request for order lines',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ lines: z.array(z.object({ orderLineId: z.string(), quantity: z.number().int().min(1), restock: z.boolean().default(true) })).min(1), reason: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Bad lines', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { code } = c.req.valid('param');
    const body = c.req.valid('json');
    const reqLines = body.lines as Array<{ orderLineId: string; quantity: number; restock: boolean }>;
    const res = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
      if (!o) return { kind: 'notfound' as const };
      const oLines = await tx.select({ id: s.orderLine.id, quantity: s.orderLine.quantity, refundedQty: s.orderLine.refundedQty }).from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      const byId = new Map(oLines.map((l) => [l.id, l]));
      for (const rl of reqLines) {
        const ol = byId.get(rl.orderLineId);
        if (!ol || rl.quantity > ol.quantity - ol.refundedQty) return { kind: 'badlines' as const };
      }
      const [rr] = await tx.insert(s.returnRequest).values({ storeId: st.storeId, orderId: o.id, reason: body.reason ?? null, status: 'requested' }).returning({ id: s.returnRequest.id });
      await tx.insert(s.returnLine).values(reqLines.map((rl) => ({ storeId: st.storeId, returnId: rr!.id, orderLineId: rl.orderLineId, quantity: rl.quantity, restock: rl.restock })));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'return', entityId: rr!.id, action: 'create', data: { orderCode: code, lines: reqLines.length } });
      return { kind: 'ok' as const, id: rr!.id };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badlines') throw new HttpError(409, 'return quantity exceeds the unrefunded quantity on a line');
    return c.json({ id: res.id }, 200);
  }),
);

adminOrders.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/returns', summary: 'List return requests',
    request: { query: z.object({
      status: z.enum(['requested', 'approved', 'rejected', 'received', 'refunded']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { status, page, pageSize } = c.req.valid('query');
    // Paginated (was a silent limit(200) that dropped older returns off the list).
    const out = await withStore(st.storeId, async (tx) => {
      const where = status ? eq(s.returnRequest.status, status) : undefined;
      const base = tx.select({ id: s.returnRequest.id, status: s.returnRequest.status, reason: s.returnRequest.reason, orderCode: s.order.code, createdAt: s.returnRequest.createdAt })
        .from(s.returnRequest).innerJoin(s.order, eq(s.order.id, s.returnRequest.orderId)).$dynamic();
      const rows = await (where ? base.where(where) : base).orderBy(desc(s.returnRequest.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
      const cntQ = tx.select({ n: sql<number>`count(*)::int` }).from(s.returnRequest).$dynamic();
      const cnt = await (where ? cntQ.where(where) : cntQ);
      return { items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), total: cnt[0]?.n ?? 0, page, pageSize };
    });
    return c.json(out, 200);
  }),
);

adminOrders.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/returns/{id}/approve', summary: 'Approve a return: restock + record refund',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), refunded: money, state: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const res = await withStore(st.storeId, async (tx) => {
      const [rr] = await tx.select().from(s.returnRequest).where(eq(s.returnRequest.id, id)).limit(1);
      if (!rr) return { kind: 'notfound' as const };
      if (rr.status !== 'requested' && rr.status !== 'approved') return { kind: 'badstate' as const, status: rr.status };
      const [o] = await tx.select().from(s.order).where(eq(s.order.id, rr.orderId)).limit(1);
      if (!o) return { kind: 'notfound' as const };
      const [pay] = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, o.id), eq(s.payment.state, 'Settled'))).orderBy(desc(s.payment.createdAt)).limit(1);
      if (!pay) return { kind: 'nopayment' as const };
      const rLines = await tx.select().from(s.returnLine).where(eq(s.returnLine.returnId, rr.id));
      const oLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      const byId = new Map(oLines.map((l) => [l.id, l]));

      let amount = 0;
      for (const rl of rLines) { const ol = byId.get(rl.orderLineId); if (ol) amount += Math.round((ol.lineTotal / ol.quantity) * rl.quantity); }
      const priorRefunded = await alreadyRefunded(tx, o.id);
      if (amount <= 0 || amount > o.grandTotal - priorRefunded) return { kind: 'badamount' as const };

      // ra-022: validate the FSM transition BEFORE writing any ledger rows so an
      // invalid transition rolls back without leaving an orphan Settled refund.
      const newState: OrderState = priorRefunded + amount >= o.grandTotal ? 'Refunded' : 'PartiallyRefunded';
      if (!canTransition(o.state as OrderState, newState)) return { kind: 'badstate' as const, status: o.state };

      // ra-002: call the payment gateway BEFORE writing the ledger row. For
      // manual/cod (no provider.refundPayment) this is a no-op returning Settled.
      // A gateway failure throws { kind: 'providerfail' } which propagates up and
      // causes the withStore() txn to roll back — no orphan refund row.
      let gatewayResult: { state: 'Settled' | 'Pending'; providerRef: string | null };
      try {
        gatewayResult = await executeGatewayRefund(tx, st.storeId, pay.method, pay.providerRef, amount, o.currency);
      } catch (e: unknown) {
        const err = e as { kind?: string; message?: string };
        if (err.kind === 'providerfail') return { kind: 'providerfail' as const, message: err.message ?? 'gateway refund failed' };
        throw e;
      }

      const [refund] = await tx.insert(s.refund).values({ storeId: st.storeId, paymentId: pay.id, orderId: o.id, amount, reason: rr.reason ?? 'return', state: gatewayResult.state, providerRef: gatewayResult.providerRef }).returning({ id: s.refund.id });
      for (const rl of rLines) {
        const ol = byId.get(rl.orderLineId); if (!ol) continue;
        await tx.insert(s.refundLine).values({ storeId: st.storeId, refundId: refund!.id, orderLineId: ol.id, quantity: rl.quantity, amount: Math.round((ol.lineTotal / ol.quantity) * rl.quantity), restock: rl.restock });
        await tx.update(s.orderLine).set({ refundedQty: Math.min(ol.quantity, ol.refundedQty + rl.quantity) }).where(eq(s.orderLine.id, ol.id));
        if (rl.restock && ol.variantId) {
          await tx.update(s.stock).set({ onHand: sql`${s.stock.onHand} + ${rl.quantity}` }).where(and(eq(s.stock.variantId, ol.variantId), eq(s.stock.storeId, st.storeId)));
          await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: ol.variantId, delta: rl.quantity, reason: 'return_restock', refOrderId: o.id });
        }
      }
      await tx.update(s.order).set({ state: newState, updatedAt: new Date() }).where(eq(s.order.id, o.id));
      await tx.update(s.returnRequest).set({ status: 'refunded', refundId: refund!.id, updatedAt: new Date() }).where(eq(s.returnRequest.id, rr.id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'return', entityId: rr.id, action: 'approve', toState: newState, data: { amount } });
      return { kind: 'ok' as const, refunded: amount, state: newState };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'return not found');
    if (res.kind === 'badstate') throw new HttpError(409, `return cannot be approved — order is in state ${res.status} which does not allow transition`);
    if (res.kind === 'nopayment') throw new HttpError(409, 'no settled payment to refund against');
    if (res.kind === 'badamount') throw new HttpError(409, 'return amount exceeds the refundable balance');
    if (res.kind === 'providerfail') throw new HttpError(502, res.message);
    return c.json({ id, refunded: res.refunded, state: res.state }, 200);
  }),
);

adminOrders.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/returns/{id}/reject', summary: 'Reject a return request',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const ok = await withStore(st.storeId, async (tx) => {
      const [rr] = await tx.select({ id: s.returnRequest.id }).from(s.returnRequest).where(eq(s.returnRequest.id, id)).limit(1);
      if (!rr) return false;
      await tx.update(s.returnRequest).set({ status: 'rejected', updatedAt: new Date() }).where(eq(s.returnRequest.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'return', entityId: id, action: 'reject' });
      return true;
    });
    if (!ok) throw new HttpError(404, 'return not found');
    return c.json({ id }, 200);
  }),
);

// ── draft / manual orders ────────────────────────────────────────────────────
adminOrders.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/draft-orders', summary: 'Create a manual order (e.g. phone order)',
    request: { body: { content: J(z.object({
      items: z.array(z.object({ sku: z.string(), quantity: z.number().int().min(1) })).min(1),
      email: z.string().email().optional(),
      shipping: money.default(0),
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
    const res = await withStore(st.storeId, async (tx) => {
      const variants = await tx.select().from(s.productVariant).where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)));
      const bySku = new Map(variants.map((v) => [v.sku, v]));
      const blocked = validateReservableItems(items, bySku);
      if (blocked.length) return { kind: 'blocked' as const, skus: blocked };
      await reserveStockOrThrow(tx, st.storeId, items, bySku);
      const priced = items.map((i) => { const v = bySku.get(i.sku)!; return { v, qty: i.quantity, unitPrice: unitPrice(v) }; });
      // Mirror the edit-lines path: resolve the destination tax zone and honour the
      // store's tax-inclusive flag. Omitting taxInclusive here mispriced every
      // tax-inclusive store's manual/phone orders.
      const [storeRow] = await tx.select({ taxRate: s.store.taxRate, taxInclusive: s.store.taxInclusive, shippingTaxable: s.store.shippingTaxable }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
      if (!storeRow) throw new HttpError(404, 'store not found');
      const shipCountry = (body.shippingAddress as { country?: string } | null | undefined)?.country ?? null;
      const zones = await tx.select({ countries: s.taxZone.countries, rate: s.taxZone.rate, priority: s.taxZone.priority }).from(s.taxZone).where(eq(s.taxZone.enabled, true));
      const taxRate = resolveTaxRate(zones, shipCountry, storeRow.taxRate);
      const totals = calculateOrderTotals({ lines: priced.map((p) => ({ unitPrice: p.unitPrice, quantity: p.qty })), shipping: body.shipping, taxRate, taxInclusive: storeRow.taxInclusive, shippingTaxable: storeRow.shippingTaxable });
      const customerId = body.email ? (await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, normalizeEmail(body.email))).limit(1))[0]?.id ?? null : null;
      const orderId = randomUUID(); const code = orderCode();
      const paid = body.markPaid;
      await tx.insert(s.order).values({ id: orderId, storeId: st.storeId, code, customerId, state: paid ? 'Paid' : 'PendingPayment', currency: st.currency, subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, placedAt: paid ? new Date() : null, shippingAddress: body.shippingAddress ?? null });
      await tx.insert(s.orderLine).values(priced.map((p, idx) => ({ storeId: st.storeId, orderId, variantId: p.v.id, variantSku: p.v.sku, variantName: p.v.name, quantity: p.qty, unitPrice: p.unitPrice, lineSubtotal: totals.lines[idx]!.lineSubtotal, lineDiscount: totals.lines[idx]!.lineDiscount, lineTax: 0, lineTotal: totals.lines[idx]!.lineTotal })));
      if (paid) await tx.insert(s.payment).values({ storeId: st.storeId, orderId, amount: totals.grandTotal, method: 'manual', providerRef: `admin-${code}`, state: 'Settled', metadata: { manual: true, by: admin.email } });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: orderId, action: 'draft_create', toState: paid ? 'Paid' : 'PendingPayment' });
      return { kind: 'ok' as const, code, state: paid ? 'Paid' : 'PendingPayment', grandTotal: totals.grandTotal };
    }).catch((e: unknown) => {
      if (e instanceof StockReservationError) return { kind: 'blocked' as const, skus: e.skus };
      throw e;
    });
    if (res.kind === 'blocked') return c.json({ error: 'unavailable or out of stock', skus: res.skus }, 409);
    return c.json({ code: res.code, state: res.state, grandTotal: res.grandTotal }, 200);
  }),
);

// ── abandoned carts ──────────────────────────────────────────────────────────
adminOrders.openapi(
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

// ── order export (CSV) ───────────────────────────────────────────────────────
// Plain handler (not .openapi) so it can stream text/csv as a download.
adminOrders.get('/v1/admin/export/orders', async (c) => {
  try {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const days = Math.min(3650, Math.max(1, Number(c.req.query('days') ?? '365')));
    const state = c.req.query('state') || undefined;
    const rows = await withStore(st.storeId, async (tx) => {
      const conds = [sql`coalesce(${s.order.placedAt}, ${s.order.createdAt}) >= now() - (${days} || ' days')::interval`, sql`${s.order.deletedAt} is null`] as never[];
      if (state) conds.push(sql`${s.order.state} = ${state}` as never);
      return tx
        .select({
          code: s.order.code, state: s.order.state, isPreOrder: s.order.isPreOrder, email: s.customer.email,
          subtotal: s.order.subtotal, discountTotal: s.order.discountTotal, shippingTotal: s.order.shippingTotal,
          taxTotal: s.order.taxTotal, grandTotal: s.order.grandTotal, currency: s.order.currency,
          placedAt: s.order.placedAt, createdAt: s.order.createdAt,
          tracking: sql<string | null>`(select f.tracking_code from fulfillment f where f.order_id = ${s.order.id} order by f.created_at desc limit 1)`,
          fulfillmentState: sql<string | null>`(select f.state from fulfillment f where f.order_id = ${s.order.id} order by f.created_at desc limit 1)`,
        })
        .from(s.order).leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
        .where(and(...conds)).orderBy(desc(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt})`)).limit(50000);
    });
    const header = ['code', 'date', 'email', 'state', 'preOrder', 'fulfillment', 'tracking', 'subtotal', 'discount', 'shipping', 'tax', 'total', 'currency'];
    const lines = [header.join(',')];
    const c2 = (n: number) => (n / 100).toFixed(2);
    for (const r of rows) {
      lines.push([r.code, (r.placedAt ?? r.createdAt).toISOString().slice(0, 10), r.email ?? '', r.state, r.isPreOrder ? 'yes' : '', r.fulfillmentState ?? '', r.tracking ?? '', c2(r.subtotal), c2(r.discountTotal), c2(r.shippingTotal), c2(r.taxTotal), c2(r.grandTotal), r.currency].map(csvCell).join(','));
    }
    return c.body(lines.join('\n'), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="orders-${st.slug}.csv"` });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// ── tracking CSV import (bulk fulfill -> Shipped) ────────────────────────────
adminOrders.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/import-tracking', summary: 'Bulk import tracking numbers (creates Shipped fulfillments)',
    request: { body: { content: J(z.object({ rows: z.array(z.object({ code: z.string(), tracking: z.string(), carrier: z.string().optional() })).min(1).max(5000) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ updated: z.number().int(), errors: z.array(z.object({ code: z.string(), error: z.string() })) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { rows } = c.req.valid('json');
    const result = await withStore(st.storeId, async (tx) => {
      let updated = 0; const errors: { code: string; error: string }[] = [];
      const notifications: Array<{ email: string; code: string; tracking: string; carrier: string | null }> = [];
      for (const row of rows) {
        const [o] = await tx.select().from(s.order).where(eq(s.order.code, row.code)).limit(1);
        if (!o) { errors.push({ code: row.code, error: 'order not found' }); continue; }
        if (o.state !== 'Paid' && o.state !== 'PartiallyRefunded') { errors.push({ code: row.code, error: `not shippable (${o.state})` }); continue; }
        const carrier = row.carrier || inferCarrier(row.tracking) || null;
        const [existing] = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt)).limit(1);
        if (existing) {
          // ra-023: do not regress a Delivered fulfillment back to Shipped.
          if (existing.state === 'Delivered') { errors.push({ code: row.code, error: 'already Delivered' }); continue; }
          await tx.update(s.fulfillment).set({ state: 'Shipped', trackingCode: row.tracking, carrier, updatedAt: new Date() }).where(eq(s.fulfillment.id, existing.id));
        } else {
          await tx.insert(s.fulfillment).values({ storeId: st.storeId, orderId: o.id, state: 'Shipped', trackingCode: row.tracking, carrier });
          const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
          for (const l of lines) {
            const ship = l.quantity - l.fulfilledQty;
            if (ship <= 0) continue;
            await tx.update(s.orderLine).set({ fulfilledQty: l.quantity }).where(eq(s.orderLine.id, l.id));
            if (l.variantId) {
              await tx.update(s.stock).set({ onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`, allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)` }).where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
              await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: o.id });
            }
          }
        }
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'tracking_import', toState: 'Shipped', data: { tracking: row.tracking, carrier } });
        // WP2: emit order.shipped + best-effort email for the newly-Shipped order.
        // `emitEvent` runs inside the same txn so the webhook delivery is
        // committed atomically with the Shipped state transition. Guard
        // customerId (nullable FK) before the eq().
        await emitEvent(tx, st.storeId, 'order.shipped', { code: o.code, trackingCode: row.tracking, carrier });
        if (o.customerId) {
          const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
          if (cust?.email) notifications.push({ email: cust.email, code: o.code, tracking: row.tracking, carrier });
        }
        updated++;
      }
      return { updated, errors, notifications };
    });
    // WP2: fire-and-forget emails (failure here doesn't fail the import).
    for (const n of result.notifications) {
      try { await sendShippingNotification({ name: st.name, currency: st.currency }, n.email, { code: n.code, trackingCode: n.tracking, carrier: n.carrier }); } catch (e) { console.error('[email:shipping] failed', e); }
    }
    return c.json({ updated: result.updated, errors: result.errors }, 200);
  }),
);

// ── bulk order management: cancel / soft-delete (trash) / restore / purge ──────
// All four mirror bulk-fulfill: dedup codes → per-order withStore → one result
// row each → { results, succeeded, skipped }. One bad order never fails the batch.

// ── bulk cancel (unpaid orders only — releases stock; paid orders are skipped,
//    use Refund for those so money is handled explicitly) ──────────────────────
adminOrders.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/bulk-cancel', summary: 'Cancel multiple unpaid orders (release stock)',
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
        const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
        if (!o) return { ok: false, error: 'order not found' };
        if (o.state === 'Cancelled') return { ok: false, error: 'already cancelled' };
        if (o.state !== 'PendingPayment') return { ok: false, error: `paid order — use Refund (state ${o.state})` };
        if (!canTransition(o.state as OrderState, 'Cancelled')) return { ok: false, error: `cannot cancel from ${o.state}` };
        const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
        for (const l of lines) {
          const rel = l.quantity - l.fulfilledQty;
          if (rel > 0 && l.variantId) {
            await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${rel}, 0)` })
              .where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
          }
        }
        await tx.update(s.order).set({ state: 'Cancelled', updatedAt: new Date() }).where(eq(s.order.id, o.id));
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'cancel', fromState: o.state, toState: 'Cancelled' });
        return { ok: true };
      });
      results.push(r.ok ? { code, ok: true } : { code, ok: false, error: r.error });
    }
    const succeeded = results.filter((r) => r.ok).length;
    return c.json({ results, succeeded, skipped: results.length - succeeded }, 200);
  }),
);

// ── soft-delete (trash) / restore — reversible "remove from my view" ──────────
adminOrders.openapi(
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

adminOrders.openapi(
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
adminOrders.openapi(
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
    for (const code of [...new Set(codes)] as string[]) {
      const r = await withStore(st.storeId, async (tx): Promise<{ ok: true } | { ok: false; error: string }> => {
        const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
        if (!o) return { ok: false, error: 'order not found' };
        if (!o.deletedAt) return { ok: false, error: 'trash the order first (purge only removes trashed orders)' };
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
        await tx.update(s.giftCardTransaction).set({ orderId: null }).where(eq(s.giftCardTransaction.orderId, o.id));
        await tx.update(s.stockMovement).set({ refOrderId: null }).where(eq(s.stockMovement.refOrderId, o.id));
        // A converted cart points back at this order (nullable FK) — detach it so
        // the order row can be deleted (the cart row itself is analytics, kept).
        await tx.update(s.cart).set({ convertedOrderId: null }).where(eq(s.cart.convertedOrderId, o.id));
        // A subscription's backing order (nullable FK) — detach so the order can be
        // purged; the subscription row (Stripe link) is kept.
        await tx.update(s.subscription).set({ orderId: null }).where(eq(s.subscription.orderId, o.id));
        await tx.delete(s.payment).where(eq(s.payment.orderId, o.id));
        await tx.delete(s.orderLine).where(eq(s.orderLine.orderId, o.id));
        await tx.delete(s.order).where(eq(s.order.id, o.id));
        return { ok: true };
      });
      results.push(r.ok ? { code, ok: true } : { code, ok: false, error: r.error });
    }
    const succeeded = results.filter((r) => r.ok).length;
    return c.json({ results, succeeded, skipped: results.length - succeeded }, 200);
  }),
);
