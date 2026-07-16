import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { bearer } from '../auth/session.js';
import { verifyPassword } from '../auth/password.js';
import { createAdminSession, deleteAdminSession, findAdminByEmail, resolveAdmin } from '../auth/admin-session.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, requirePermission, guard, Page } from './admin-helpers.js';
import { clientIp, loginRetryAfter, recordLoginFailure, clearLoginAttempts } from '../auth/rate-limit.js';
import { setAuthCookies, clearAuthCookies, newCsrf, cookie, csrfValid, SESSION_COOKIE } from '../auth/cookies.js';
import { verifyTotp } from '../auth/totp.js';
import { normalizeEmail } from '../auth/email.js';
import { sendShippingNotification } from '../email/dispatch.js';
import { emitEvent } from '../webhooks/emit.js';
import { err as logErr } from '../lib/logger.js';

export const admin = new OpenAPIHono();

const StoreAccess = z.object({ storeId: z.string(), slug: z.string(), name: z.string(), currency: z.string(), role: z.string() });

// ── auth: login / logout / me ─────────────────────────────────────────────
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/login', summary: 'Admin login',
    request: { body: { content: J(z.object({ email: z.string().email(), password: z.string(), totp: z.string().optional() })) } },
    responses: {
      200: { description: 'OK or 2FA required', content: J(z.object({ token: z.string().optional(), csrfToken: z.string().optional(), twoFactorRequired: z.boolean().optional(), admin: z.object({ email: z.string() }).optional(), stores: z.array(StoreAccess).optional() })) },
      401: { description: 'Invalid', ...errBody },
      429: { description: 'Too many attempts', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { email: rawEmail, password, totp } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const retry = loginRetryAfter(ip, `admin:${email}`);
    if (retry > 0) throw new HttpError(429, `too many attempts — try again in ${retry}s`);
    const u = await findAdminByEmail(email);
    // WP1.5: do NOT confirm password validity to unauthenticated callers. The
    // previous shape returned {twoFactorRequired:true} for valid password +
    // missing TOTP, which let an attacker enumerate "valid password" + "2FA
    // enabled" via the response. The fix: treat a 2FA-enabled account with a
    // missing TOTP as a single incomplete login attempt (401, generic message).
    // The UI must always send both password and TOTP together.
    if (!u || !(await verifyPassword(password, u.passwordHash))) { recordLoginFailure(ip, `admin:${email}`); throw new HttpError(401, 'invalid email, password, or 2FA code'); }
    if (u.totpSecret) {
      if (!totp) { recordLoginFailure(ip, `admin:${email}`); throw new HttpError(401, 'invalid email, password, or 2FA code'); }
      if (!verifyTotp(u.totpSecret, totp, u.id)) { recordLoginFailure(ip, `admin:${email}`); throw new HttpError(401, 'invalid email, password, or 2FA code'); }
    }
    clearLoginAttempts(ip, `admin:${email}`);
    const token = await createAdminSession(u.id);
    const csrf = newCsrf();
    setAuthCookies(c, token, csrf); // httpOnly session cookie + CSRF cookie
    const admin = await resolveAdmin(token);
    return c.json({ token, csrfToken: csrf, admin: { email: u.email }, stores: admin?.stores ?? [] }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/logout', summary: 'Admin logout',
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) },
      403: { description: 'CSRF', ...errBody },
    },
  }),
  async (c) => {
    if (!csrfValid(c)) return c.json({ error: 'invalid CSRF token' }, 403);
    const token = bearer(c.req.header('authorization')) ?? cookie(c, SESSION_COOKIE);
    if (token) await deleteAdminSession(token);
    clearAuthCookies(c);
    return c.json({ ok: true }, 200);
  },
);

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/me', summary: 'Current admin + accessible stores',
    responses: {
      200: { description: 'OK', content: J(z.object({ email: z.string(), stores: z.array(StoreAccess) })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    return c.json({ email: admin.email, stores: admin.stores }, 200);
  }),
);

// ── orders: list / detail / fulfill / cancel ────────────────────────────────
admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders', summary: 'List orders',
    request: { query: z.object({ state: z.string().optional(), q: z.string().optional(), preOrder: z.coerce.boolean().optional(), trashed: z.coerce.boolean().default(false), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { state, q, preOrder, trashed, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [] as ReturnType<typeof eq>[];
      // Trash filter FIRST: ?trashed=1 shows ONLY soft-deleted orders; default
      // shows only live ones. Without this, trashed orders leak into every list.
      conds.push((trashed ? sql`${s.order.deletedAt} is not null` : sql`${s.order.deletedAt} is null`) as never);
      if (state) conds.push(sql`${s.order.state} = ${state}` as never);
      if (preOrder) conds.push(eq(s.order.isPreOrder, true) as never);
      if (q) conds.push(or(ilike(s.order.code, `%${q}%`), ilike(s.customer.email, `%${q}%`)) as never);
      const where = conds.length ? and(...conds) : undefined;
      const base = tx
        .select({ code: s.order.code, state: s.order.state, isPreOrder: s.order.isPreOrder, grandTotal: s.order.grandTotal, currency: s.order.currency, placedAt: s.order.placedAt, createdAt: s.order.createdAt, email: s.customer.email })
        .from(s.order)
        .leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
        .$dynamic();
      const rows = await (where ? base.where(where) : base)
        .orderBy(desc(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt})`))
        .limit(pageSize).offset((page - 1) * pageSize);
      const cntBase = tx.select({ n: sql<number>`count(*)::int` }).from(s.order).leftJoin(s.customer, eq(s.customer.id, s.order.customerId)).$dynamic();
      const [cnt] = await (where ? cntBase.where(where) : cntBase);
      return {
        items: rows.map((r) => ({ ...r, placedAt: r.placedAt ? r.placedAt.toISOString() : null, createdAt: r.createdAt.toISOString() })),
        total: cnt?.n ?? 0, page, pageSize,
      };
    });
    return c.json(out, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders/{code}', summary: 'Order detail',
    request: { params: z.object({ code: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { code } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return null;
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      const payments = await tx.select().from(s.payment).where(eq(s.payment.orderId, o.id)).orderBy(desc(s.payment.createdAt));
      const fulfillments = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt));
      const events = await tx.select().from(s.auditLog).where(and(eq(s.auditLog.entity, 'order'), eq(s.auditLog.entityId, o.id))).orderBy(desc(s.auditLog.at)).limit(50);
      let customer = null as null | { id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null };
      if (o.customerId) {
        const [cu] = await tx.select({ id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
        customer = cu ?? null;
      }
      return {
        code: o.code, state: o.state, isPreOrder: o.isPreOrder, currency: o.currency,
        subtotal: o.subtotal, discountTotal: o.discountTotal, shippingTotal: o.shippingTotal, taxTotal: o.taxTotal, grandTotal: o.grandTotal,
        placedAt: o.placedAt ? o.placedAt.toISOString() : null, createdAt: o.createdAt.toISOString(),
        shippingAddress: o.shippingAddress ?? null, billingAddress: o.billingAddress ?? null,
        customer,
        // `id` is the order_line id the refund/return endpoints key their
        // `lines[].orderLineId` on — without it no consumer of this response can
        // build a per-line refund.
        lines: lines.map((l) => ({ id: l.id, sku: l.variantSku, name: l.variantName, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty })),
        payments: payments.map((p) => ({ method: p.method, amount: p.amount, state: p.state, providerRef: p.providerRef, createdAt: p.createdAt.toISOString() })),
        fulfillments: fulfillments.map((f) => ({ id: f.id, state: f.state, trackingCode: f.trackingCode, carrier: f.carrier, createdAt: f.createdAt.toISOString() })),
        events: events.map((e) => ({ action: e.action, fromState: e.fromState, toState: e.toState, actor: e.actor, at: e.at.toISOString() })),
      };
    });
    if (!out) throw new HttpError(404, 'order not found');
    return c.json(out, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/fulfill', summary: 'Fulfill order (Shipped/Delivered)',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ state: z.enum(['Shipped', 'Delivered']).default('Shipped'), trackingCode: z.string().optional(), carrier: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), fulfillment: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { code } = c.req.valid('param');
    const { state, trackingCode, carrier } = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return { kind: 'notfound' as const };
      if (o.state !== 'Paid' && o.state !== 'PartiallyRefunded') return { kind: 'badstate' as const, state: o.state };
      const [existing] = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt)).limit(1);
      // Fulfillment state only advances: Pending -> Shipped -> Delivered. Block
      // a backward move (e.g. re-shipping an already-Delivered order).
      if (existing && existing.state === 'Delivered' && state === 'Shipped') return { kind: 'regress' as const, state: existing.state };
      const advancingToShipped = state === 'Shipped' && (!existing || existing.state === 'Pending');
      let fid: string;
      if (existing) {
        await tx.update(s.fulfillment).set({ state, trackingCode: trackingCode ?? existing.trackingCode, carrier: carrier ?? existing.carrier, updatedAt: new Date() }).where(eq(s.fulfillment.id, existing.id));
        fid = existing.id;
      } else {
        const [f] = await tx.insert(s.fulfillment).values({ storeId: st.storeId, orderId: o.id, state, trackingCode: trackingCode ?? null, carrier: carrier ?? null }).returning({ id: s.fulfillment.id });
        fid = f!.id;
      }
      // On the transition INTO Shipped (not on a repeat call), ship every line in
      // full (all-or-nothing fulfillment — partial qty is a v2 feature). Shipping
      // consumes reserved stock: decrement on_hand AND release allocated for the
      // shipped units, and record the movement.
      if (advancingToShipped) {
        const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
        for (const l of lines) {
          const ship = l.quantity - l.fulfilledQty;
          if (ship <= 0) continue;
          await tx.update(s.orderLine).set({ fulfilledQty: l.quantity }).where(eq(s.orderLine.id, l.id));
          if (l.variantId) {
            await tx.update(s.stock).set({
              onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`,
              allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)`,
            }).where(eq(s.stock.variantId, l.variantId));
            await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: o.id });
          }
        }
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'fulfill', toState: state });
      // WP2: emit order.shipped (existing webhook pattern) + best-effort email
      // to the linked customer. Only on the first Shipped transition so we
      // don't double-email a re-fulfill that just refreshes tracking. Both the
      // webhook emit and the Shipped state commit in the same txn.
      // Webhook fires for ALL orders (3rd-party fulfillment/analytics subscribers);
      // the customer email is gated on customerId (nullable FK → eq() needs guard).
      let emailTo: string | null = null;
      if (state === 'Shipped' && advancingToShipped) {
        await emitEvent(tx, st.storeId, 'order.shipped', { code, trackingCode: trackingCode ?? null, carrier: carrier ?? null });
        if (o.customerId) {
          const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
          if (cust?.email) emailTo = cust.email;
        }
      }
      return { kind: 'ok' as const, fid, state, emailTo, trackingCode: trackingCode ?? null, carrier: carrier ?? null };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `order not fulfillable in state ${res.state}`);
    if (res.kind === 'regress') throw new HttpError(409, `cannot move fulfillment from ${res.state} back to Shipped`);
    // WP2: best-effort email AFTER the txn commits (failure doesn't roll back
    // the Shipped state). Webhook is already in the outbox via the txn above.
    if (res.emailTo) {
      try { await sendShippingNotification({ name: st.name, currency: st.currency }, res.emailTo, { code, trackingCode: res.trackingCode, carrier: res.carrier }); } catch (e) { logErr.error('email shipping failed', e, { orderCode: code }); }
    }
    return c.json({ code, fulfillment: res.state }, 200);
  }),
);

// ── bulk order fulfillment (Phase 4) ──────────────────────────────────────────
// Per-order outcomes — one bad apple never fails the whole batch. The UI uses
// the per-row result to render an "X succeeded, Y skipped" panel after the
// action. The bulk endpoint is a fan-out of POST /orders/{code}/fulfill
// sharing the same transition rules + audit + shipping notification semantics.
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/bulk-fulfill', summary: 'Fulfill multiple orders in one batch',
    request: {
      body: {
        content: J(z.object({
          orders: z.array(z.object({
            code: z.string().min(1),
            state: z.enum(['Shipped', 'Delivered']).default('Shipped'),
            trackingCode: z.string().optional(),
            carrier: z.string().optional(),
          })).min(1).max(100),
        })),
      },
    },
    responses: {
      200: { description: 'OK', content: J(z.object({
        results: z.array(z.object({
          code: z.string(),
          ok: z.boolean(),
          fulfillment: z.string().optional(),
          error: z.string().optional(),
        })),
        succeeded: z.number().int(),
        skipped: z.number().int(),
      })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { orders } = c.req.valid('json');
    const results: { code: string; ok: boolean; fulfillment?: string; error?: string }[] = [];
    // De-duplicate by code within a single request — last write wins, but we
    // only emit one row to the caller. Keeps the result panel honest.
    const seen = new Map<string, typeof orders[number]>();
    for (const o of orders) seen.set(o.code, o);
    const deduped = [...seen.values()];
    for (const o of deduped) {
      const res = await withStore(st.storeId, async (tx): Promise<{ kind: 'ok' | 'notfound' | 'badstate' | 'regress'; state?: string; emailTo?: string | null; trackingCode?: string | null; carrier?: string | null }> => {
        const [order] = await tx.select().from(s.order).where(eq(s.order.code, o.code)).limit(1);
        if (!order) return { kind: 'notfound' };
        if (order.state !== 'Paid' && order.state !== 'PartiallyRefunded') return { kind: 'badstate', state: order.state };
        const [existing] = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, order.id)).orderBy(desc(s.fulfillment.createdAt)).limit(1);
        if (existing && existing.state === 'Delivered' && o.state === 'Shipped') return { kind: 'regress', state: existing.state };
        if (o.state === 'Delivered' && (!existing || existing.state !== 'Shipped')) return { kind: 'badstate', state: existing?.state ?? 'Unfulfilled' };
        const advancingToShipped = o.state === 'Shipped' && (!existing || existing.state === 'Pending');
        if (existing) {
          await tx.update(s.fulfillment).set({ state: o.state, trackingCode: o.trackingCode ?? existing.trackingCode, carrier: o.carrier ?? existing.carrier, updatedAt: new Date() }).where(eq(s.fulfillment.id, existing.id));
        } else {
          await tx.insert(s.fulfillment).values({ storeId: st.storeId, orderId: order.id, state: o.state, trackingCode: o.trackingCode ?? null, carrier: o.carrier ?? null });
        }
        if (advancingToShipped) {
          const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, order.id));
          for (const l of lines) {
            const ship = l.quantity - l.fulfilledQty;
            if (ship <= 0) continue;
            await tx.update(s.orderLine).set({ fulfilledQty: l.quantity }).where(eq(s.orderLine.id, l.id));
            if (l.variantId) {
              await tx.update(s.stock).set({
                onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`,
                allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)`,
              }).where(eq(s.stock.variantId, l.variantId));
              await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: order.id });
            }
          }
        }
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: order.id, action: 'fulfill', toState: o.state });
        let emailTo: string | null = null;
        if (o.state === 'Shipped' && advancingToShipped) {
          await emitEvent(tx, st.storeId, 'order.shipped', { code: o.code, trackingCode: o.trackingCode ?? null, carrier: o.carrier ?? null });
          if (order.customerId) {
            const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1);
            if (cust?.email) emailTo = cust.email;
          }
        }
        return { kind: 'ok', state: o.state, emailTo, trackingCode: o.trackingCode ?? null, carrier: o.carrier ?? null };
      });
      if (res.kind === 'ok') {
        results.push({ code: o.code, ok: true, fulfillment: res.state });
        if (res.emailTo) {
          try { await sendShippingNotification({ name: st.name, currency: st.currency }, res.emailTo, { code: o.code, trackingCode: res.trackingCode ?? null, carrier: res.carrier ?? null }); } catch (e) { logErr.error('email shipping failed', e, { orderCode: o.code }); }
        }
      } else if (res.kind === 'notfound') {
        results.push({ code: o.code, ok: false, error: 'not found' });
      } else if (res.kind === 'badstate') {
        results.push({ code: o.code, ok: false, error: `not fulfillable in state ${res.state}` });
      } else {
        results.push({ code: o.code, ok: false, error: `cannot move fulfillment from ${res.state} back to Shipped` });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    const skipped = results.length - succeeded;
    return c.json({ results, succeeded, skipped }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/cancel', summary: 'Cancel order',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ reason: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), state: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    requirePermission(st, 'cancel_orders');
    const { code } = c.req.valid('param');
    const res = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return { kind: 'notfound' as const };
      if (!canTransition(o.state as OrderState, 'Cancelled')) return { kind: 'badstate' as const, state: o.state };
      // Release stock still reserved for unshipped units. Shipped units already
      // had their allocation released (see fulfill), so release = unfulfilled qty.
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      for (const l of lines) {
        const release = l.quantity - l.fulfilledQty;
        if (release > 0 && l.variantId) {
          await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${release}, 0)` })
            .where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
        }
      }
      await tx.update(s.order).set({ state: 'Cancelled', updatedAt: new Date() }).where(eq(s.order.id, o.id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'cancel', fromState: o.state, toState: 'Cancelled' });
      return { kind: 'ok' as const };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `cannot cancel order in state ${res.state}`);
    return c.json({ code, state: 'Cancelled' }, 200);
  }),
);
