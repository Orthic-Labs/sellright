import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, requirePermission, guard } from './admin-helpers.js';
import { calculateOrderTotals } from '../money/totals.js';
import { reserveStockOrThrow, StockReservationError, validateReservableItems } from '../orders/stock-reservation.js';
import { normalizeEmail } from '../auth/email.js';
import { buildInvoice, buildPackingSlip, renderInvoiceHtml } from '../orders/invoice.js';
import { evaluateCoupon } from '../money/coupon.js';
import { resolveTaxRate } from '../money/tax.js';
import { requestRefund, RefundError } from '../payments/refunds.js';
import { unitPrice } from './admin-order-utils.js';
import { emitEvent } from '../webhooks/emit.js';
import { sendShippingNotification } from '../email/dispatch.js';
import { getProvider } from '../payments/provider.js';

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
        const rel = l.quantity - l.fulfilledQty - l.cancelledQty;
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

// ── refunds ──────────────────────────────────────────────────────────────────
adminOrders.openapi(createRoute({
  method: 'post', path: '/v1/admin/orders/{code}/refund', summary: 'Refund a selected payment',
  request: { params: z.object({ code: z.string() }), body: { content: J(z.object({
    idempotencyKey: z.string().min(1).max(200), paymentId: z.string().uuid().optional(), amount: money.optional(),
    lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: z.number().int().min(1) })).optional(),
    restock: z.boolean().default(false), reason: z.string().optional(),
  })) } }, responses: { 200: { description: 'Refund status', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody } },
}), async c => guard(c, async () => {
  const { admin } = await requireAdmin(c), st = requireStore(admin, c); requireWrite(st); requirePermission(st, 'refunds');
  const { code } = c.req.valid('param'), body = c.req.valid('json');
  const [order] = await withStore(st.storeId, tx => tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.code, code)));
  if (!order) throw new HttpError(404, 'Order not found');
  try {
    const result = await requestRefund({ ...body, storeId: st.storeId, orderId: order.id, actor: admin.email,
      lines: body.lines?.map(line => ({ ...line, restock: body.restock })) });
    return c.json({ code, ...result }, 200);
  } catch (error) { if (error instanceof RefundError) throw new HttpError(error.status, error.message); throw error; }
}));

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

adminOrders.openapi(createRoute({
  method: 'post', path: '/v1/admin/returns/{id}/approve', summary: 'Approve a return and reserve its refund',
  request: { params: z.object({ id: z.string().uuid() }), body: { content: J(z.object({ paymentId: z.string().uuid().optional() })) }, },
  responses: { 200: { description: 'Refund status', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody } },
}), async c => guard(c, async () => {
  const { admin } = await requireAdmin(c), st = requireStore(admin, c); requireWrite(st); requirePermission(st, 'refunds');
  const { id } = c.req.valid('param'), body = c.req.valid('json');
  const [rma] = await withStore(st.storeId, tx => tx.select().from(s.returnRequest).where(eq(s.returnRequest.id, id)));
  if (!rma) throw new HttpError(404, 'Return not found');
  try {
    const result = await requestRefund({ storeId: st.storeId, orderId: rma.orderId, actor: admin.email,
      idempotencyKey: 'return:' + id, returnId: id, paymentId: body.paymentId });
    return c.json({ id, ...result }, 200);
  } catch (error) { if (error instanceof RefundError) throw new HttpError(error.status, error.message); throw error; }
}));

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
      const [rr] = await tx.select().from(s.returnRequest).where(eq(s.returnRequest.id, id)).limit(1).for('update');
      if (!rr) return false;
      if (rr.refundId || !['requested','approved'].includes(rr.status)) throw new HttpError(409, 'Return already has a refund or is resolved');
      await tx.update(s.returnRequest).set({ status: 'rejected', updatedAt: new Date() }).where(eq(s.returnRequest.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'return', entityId: id, action: 'reject' });
      return true;
    });
    if (!ok) throw new HttpError(404, 'return not found');
    return c.json({ id }, 200);
  }),
);