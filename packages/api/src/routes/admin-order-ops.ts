import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, Page, requireAdmin, requireStore, requireWrite, requireManage, guard } from './admin-helpers.js';
import { calculateOrderTotals } from '../money/totals.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { reserveStockOrThrow, StockReservationError, validateReservableItems } from '../orders/stock-reservation.js';
import { normalizeEmail } from '../auth/email.js';
import { resolveTaxRate } from '../money/tax.js';
import { emitEvent } from '../webhooks/emit.js';
import { sendShippingNotification } from '../email/dispatch.js';
import { csvCell, inferCarrier, orderCode, unitPrice } from './admin-order-utils.js';
import { issueLicensesForPaidOrder } from '../licensing/issue.js';

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
      const paidAt = paid ? new Date() : null;
      await tx.insert(s.order).values({ id: orderId, storeId: st.storeId, code, customerId, state: paid ? 'Paid' : 'PendingPayment', currency: st.currency, subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, placedAt: paidAt, shippingAddress: body.shippingAddress ?? null });
      await tx.insert(s.orderLine).values(priced.map((p, idx) => ({ storeId: st.storeId, orderId, variantId: p.v.id, variantSku: p.v.sku, variantName: p.v.name, quantity: p.qty, unitPrice: p.unitPrice, lineSubtotal: totals.lines[idx]!.lineSubtotal, lineDiscount: totals.lines[idx]!.lineDiscount, lineTax: 0, lineTotal: totals.lines[idx]!.lineTotal })));
      if (paid) {
        await tx.insert(s.payment).values({ storeId: st.storeId, orderId, amount: totals.grandTotal, method: 'manual', providerRef: `admin-${code}`, state: 'Settled', metadata: { manual: true, by: admin.email } });
        // Every other Paid transition (checkout settle, gift-card full-cover,
        // Stripe webhook reconcile) issues licenses via this same function —
        // a phone/manual order marked paid here must not be the one path that
        // skips it. issueLicensesForPaidOrder is idempotent per orderLineId, so
        // a later real settlement of this order will not double-issue.
        await issueLicensesForPaidOrder(tx, { storeId: st.storeId, orderId, customerId, paidAt: paidAt ?? undefined });
      }
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

// ── order export (CSV) ───────────────────────────────────────────────────────
// Plain handler (not .openapi) so it can stream text/csv as a download.
adminOrderOps.get('/v1/admin/export/orders', async (c) => {
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
adminOrderOps.openapi(
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
adminOrderOps.openapi(
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

