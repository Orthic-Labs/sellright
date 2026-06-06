import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, guard } from './admin-helpers.js';
import { calculateOrderTotals } from '../money/totals.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { reserveStockOrThrow, StockReservationError, validateReservableItems } from '../orders/stock-reservation.js';
import { normalizeEmail } from '../auth/email.js';
import { buildInvoice, buildPackingSlip, renderInvoiceHtml } from '../orders/invoice.js';
import { evaluateCoupon } from '../money/coupon.js';
import { resolveTaxRate } from '../money/tax.js';

export const adminOrders = new OpenAPIHono();

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
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
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

      const [refund] = await tx.insert(s.refund).values({ storeId: st.storeId, paymentId: pay.id, orderId: o.id, amount, reason: body.reason ?? null, state: 'Settled' }).returning({ id: s.refund.id });
      for (const x of refundLines) {
        await tx.insert(s.refundLine).values({ storeId: st.storeId, refundId: refund!.id, orderLineId: x.line!.id, quantity: x.quantity, amount: Math.round((x.line!.lineTotal / x.line!.quantity) * x.quantity), restock: body.restock });
        await tx.update(s.orderLine).set({ refundedQty: Math.min(x.line!.quantity, x.line!.refundedQty + x.quantity) }).where(eq(s.orderLine.id, x.line!.id));
        if (body.restock && x.line!.variantId) {
          await tx.update(s.stock).set({ onHand: sql`${s.stock.onHand} + ${x.quantity}` }).where(and(eq(s.stock.variantId, x.line!.variantId), eq(s.stock.storeId, st.storeId)));
          await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: x.line!.variantId, delta: x.quantity, reason: 'refund_restock', refOrderId: o.id });
        }
      }
      const totalRefunded = priorRefunded + amount;
      const newState: OrderState = totalRefunded >= o.grandTotal ? 'Refunded' : 'PartiallyRefunded';
      if (canTransition(o.state as OrderState, newState)) await tx.update(s.order).set({ state: newState, updatedAt: new Date() }).where(eq(s.order.id, o.id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'refund', fromState: o.state, toState: newState, data: { amount, restock: body.restock } });
      return { kind: 'ok' as const, state: newState, refunded: amount };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `order not refundable in state ${res.state}`);
    if (res.kind === 'nopayment') throw new HttpError(409, 'no settled payment to refund');
    if (res.kind === 'badamount') throw new HttpError(409, `refund amount must be 1..${res.max} cents`);
    return c.json({ code, state: res.state, refunded: res.refunded }, 200);
  }),
);

async function alreadyRefunded(tx: { select: Function }, orderId: string): Promise<number> {
  const [r] = await (tx as any).select({ n: sql<number>`coalesce(sum(${s.refund.amount}),0)::int` }).from(s.refund).where(eq(s.refund.orderId, orderId));
  return r?.n ?? 0;
}

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
      const totals = calculateOrderTotals({ lines: priced.map((p) => ({ unitPrice: p.unitPrice, quantity: p.qty })), shipping: body.shipping, taxRate: st.taxRate, shippingTaxable: st.shippingTaxable });
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
      const conds = [sql`coalesce(${s.order.placedAt}, ${s.order.createdAt}) >= now() - (${days} || ' days')::interval`] as never[];
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
      for (const row of rows) {
        const [o] = await tx.select().from(s.order).where(eq(s.order.code, row.code)).limit(1);
        if (!o) { errors.push({ code: row.code, error: 'order not found' }); continue; }
        if (o.state !== 'Paid' && o.state !== 'PartiallyRefunded') { errors.push({ code: row.code, error: `not shippable (${o.state})` }); continue; }
        const carrier = row.carrier || inferCarrier(row.tracking) || null;
        const [existing] = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt)).limit(1);
        if (existing) {
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
        updated++;
      }
      return { updated, errors };
    });
    return c.json(result, 200);
  }),
);
