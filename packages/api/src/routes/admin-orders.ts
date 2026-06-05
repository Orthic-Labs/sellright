import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, guard } from './admin-helpers.js';
import { calculateOrderTotals } from '../money/totals.js';
import { canTransition, type OrderState } from '../money/fsm.js';

export const adminOrders = new OpenAPIHono();

const orderCode = () => ('SR' + randomUUID().replace(/-/g, '').slice(0, 10)).toUpperCase();
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
      const blocked: string[] = [];
      for (const i of items) {
        const v = bySku.get(i.sku);
        if (!v || !v.enabled) { blocked.push(i.sku); continue; }
        if (v.isPreOrder) continue;
        const r = await tx.execute(sql`UPDATE "stock" SET allocated = allocated + ${i.quantity} WHERE variant_id = ${v.id} AND store_id = ${st.storeId} AND (on_hand - allocated) >= ${i.quantity}`);
        if ((r as { rowCount: number | null }).rowCount !== 1) blocked.push(i.sku);
      }
      if (blocked.length) return { kind: 'blocked' as const, skus: blocked };
      const priced = items.map((i) => { const v = bySku.get(i.sku)!; return { v, qty: i.quantity, unitPrice: unitPrice(v) }; });
      const totals = calculateOrderTotals({ lines: priced.map((p) => ({ unitPrice: p.unitPrice, quantity: p.qty })), shipping: body.shipping, taxRate: st.taxRate });
      const customerId = body.email ? (await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, body.email)).limit(1))[0]?.id ?? null : null;
      const orderId = randomUUID(); const code = orderCode();
      const paid = body.markPaid;
      await tx.insert(s.order).values({ id: orderId, storeId: st.storeId, code, customerId, state: paid ? 'Paid' : 'PendingPayment', currency: st.currency, subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, placedAt: paid ? new Date() : null, shippingAddress: body.shippingAddress ?? null });
      await tx.insert(s.orderLine).values(priced.map((p, idx) => ({ storeId: st.storeId, orderId, variantId: p.v.id, variantSku: p.v.sku, variantName: p.v.name, quantity: p.qty, unitPrice: p.unitPrice, lineSubtotal: totals.lines[idx]!.lineSubtotal, lineDiscount: totals.lines[idx]!.lineDiscount, lineTax: 0, lineTotal: totals.lines[idx]!.lineTotal })));
      if (paid) await tx.insert(s.payment).values({ storeId: st.storeId, orderId, amount: totals.grandTotal, method: 'manual', providerRef: `admin-${code}`, state: 'Settled', metadata: { manual: true, by: admin.email } });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: orderId, action: 'draft_create', toState: paid ? 'Paid' : 'PendingPayment' });
      return { kind: 'ok' as const, code, state: paid ? 'Paid' : 'PendingPayment', grandTotal: totals.grandTotal };
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
          token: s.cart.token, status: s.cart.status, updatedAt: s.cart.updatedAt, email: s.customer.email,
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
