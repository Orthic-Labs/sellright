import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { hasUnresolvedPayment } from '../payments/hold.js';
import { errJson } from '../lib/api-error.js';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { releaseOrderLoyalty } from '../loyalty/ledger.js';
import { bearer } from '../auth/session.js';
import { verifyPassword } from '../auth/password.js';
import { createAdminSession, deleteAdminSession, findAdminByEmail, resolveAdmin } from '../auth/admin-session.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, requirePermission, guard, Page } from './admin-helpers.js';
import { clientIp, loginRetryAfter, recordLoginFailure, clearLoginAttempts } from '../auth/rate-limit.js';
import { setAuthCookies, clearAuthCookies, newCsrf, cookie, csrfValid, SESSION_COOKIE } from '../auth/cookies.js';
import { verifyTotp } from '../auth/totp.js';
import { normalizeEmail } from '../auth/email.js';
import { enqueueShippingNotification } from '../email/dispatch.js';
import { emitEvent } from '../webhooks/emit.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { deriveFulfillmentStatus, derivePaymentStatus, wirePaymentState } from '../orders/status.js';
import { fulfillmentStatusSql, paymentStatusSql } from '../orders/status-sql.js';

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
    const retry = await loginRetryAfter(ip, `admin:${email}`);
    if (retry > 0) throw new HttpError(429, `too many attempts — try again in ${retry}s`);
    const u = await findAdminByEmail(email);
    // WP1.5: do NOT confirm password validity to unauthenticated callers. The
    // previous shape returned {twoFactorRequired:true} for valid password +
    // missing TOTP, which let an attacker enumerate "valid password" + "2FA
    // enabled" via the response. The fix: treat a 2FA-enabled account with a
    // missing TOTP as a single incomplete login attempt (401, generic message).
    // The UI must always send both password and TOTP together.
    if (!u || !(await verifyPassword(password, u.passwordHash))) { await recordLoginFailure(ip, `admin:${email}`); throw new HttpError(401, 'invalid email, password, or 2FA code'); }
    if (u.totpSecret) {
      if (!totp) { await recordLoginFailure(ip, `admin:${email}`); throw new HttpError(401, 'invalid email, password, or 2FA code'); }
      if (!verifyTotp(u.totpSecret, totp, u.id)) { await recordLoginFailure(ip, `admin:${email}`); throw new HttpError(401, 'invalid email, password, or 2FA code'); }
    }
    await clearLoginAttempts(ip, `admin:${email}`);
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
    if (!csrfValid(c)) return errJson(c, 403, 'CSRF_INVALID', 'invalid CSRF token');
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
      200: { description: 'OK', content: J(z.object({ email: z.string(), isInstallationAdmin: z.boolean(), stores: z.array(StoreAccess) })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    return c.json({ email: admin.email, isInstallationAdmin: admin.isInstallationAdmin, stores: admin.stores }, 200);
  }),
);

// ── orders: list / detail / fulfill / cancel ────────────────────────────────
admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders', summary: 'List orders',
    request: { query: z.object({
      state: z.string().optional(), q: z.string().optional(), preOrder: z.coerce.boolean().optional(), trashed: z.coerce.boolean().default(false),
      // Wire-facing status filters (BREAKING, pre-1.0 — see CHANGELOG.md), on
      // top of the legacy combined `state` filter above.
      status: z.enum(['open', 'completed', 'cancelled', 'archived']).optional(),
      paymentStatus: z.enum(['pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'voided', 'failed']).optional(),
      fulfillmentStatus: z.enum(['unfulfilled', 'partially_fulfilled', 'fulfilled', 'partially_delivered', 'delivered']).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { state, q, preOrder, trashed, status, paymentStatus, fulfillmentStatus, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [] as ReturnType<typeof eq>[];
      // Trash filter FIRST: ?trashed=1 shows ONLY soft-deleted orders; default
      // shows only live ones. Without this, trashed orders leak into every list.
      conds.push((trashed ? sql`${s.order.deletedAt} is not null` : sql`${s.order.deletedAt} is null`) as never);
      if (state) conds.push(sql`${s.order.state} = ${state}` as never);
      if (status) conds.push(eq(s.order.status, status) as never);
      if (paymentStatus) conds.push(sql`${paymentStatusSql()} = ${paymentStatus}` as never);
      if (fulfillmentStatus) conds.push(sql`${fulfillmentStatusSql()} = ${fulfillmentStatus}` as never);
      if (preOrder) conds.push(eq(s.order.isPreOrder, true) as never);
      if (q) conds.push(or(ilike(s.order.code, `%${q}%`), ilike(s.customer.email, `%${q}%`)) as never);
      const where = conds.length ? and(...conds) : undefined;
      const base = tx
        .select({
          code: s.order.code, state: s.order.state, status: s.order.status,
          paymentStatus: paymentStatusSql(), fulfillmentStatus: fulfillmentStatusSql(),
          isPreOrder: s.order.isPreOrder, grandTotal: s.order.grandTotal, currency: s.order.currency, placedAt: s.order.placedAt, createdAt: s.order.createdAt, email: s.customer.email,
        })
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
      const fulfillmentLines = fulfillments.length
        ? await tx.select().from(s.fulfillmentLine).where(inArray(s.fulfillmentLine.fulfillmentId, fulfillments.map((f) => f.id)))
        : [];
      const refunds = await tx.select().from(s.refund).where(eq(s.refund.orderId, o.id)).orderBy(desc(s.refund.createdAt));
      const refundLines = refunds.length
        ? await tx.select().from(s.refundLine).where(inArray(s.refundLine.refundId, refunds.map((r) => r.id)))
        : [];
      // Locations feed the partial-fulfillment picker — enabled-only, this
      // store's own set (a single-location store still gets its default row).
      const locations = await tx.select({ id: s.location.id, name: s.location.name, code: s.location.code, isDefault: s.location.isDefault })
        .from(s.location).where(and(eq(s.location.storeId, st.storeId), eq(s.location.enabled, true))).orderBy(desc(s.location.isDefault));
      const events = await tx.select().from(s.auditLog).where(and(eq(s.auditLog.entity, 'order'), eq(s.auditLog.entityId, o.id))).orderBy(desc(s.auditLog.at)).limit(50);
      let customer = null as null | { id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null };
      if (o.customerId) {
        const [cu] = await tx.select({ id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
        customer = cu ?? null;
      }
      const paymentStatus = derivePaymentStatus(o.state, payments);
      const fulfillmentStatus = deriveFulfillmentStatus(lines, fulfillments);
      return {
        code: o.code, state: o.state, status: o.status, paymentStatus, fulfillmentStatus, isPreOrder: o.isPreOrder, currency: o.currency,
        subtotal: o.subtotal, discountTotal: o.discountTotal, shippingTotal: o.shippingTotal, taxTotal: o.taxTotal, grandTotal: o.grandTotal,
        placedAt: o.placedAt ? o.placedAt.toISOString() : null, createdAt: o.createdAt.toISOString(),
        shippingAddress: o.shippingAddress ?? null, billingAddress: o.billingAddress ?? null,
        customer,
        // `id` is the order_line id the refund/return endpoints key their
        // `lines[].orderLineId` on — without it no consumer of this response can
        // build a per-line refund.
        lines: lines.map((l) => ({ id: l.id, sku: l.variantSku, name: l.variantName, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, fulfilledQty: l.fulfilledQty, cancelledQty: l.cancelledQty, refundedQty: l.refundedQty })),
        // `state` here is the individual PAYMENT record's wire state (Settled
        // -> captured — BREAKING, pre-1.0), distinct from the order-level
        // `paymentStatus` above. See orders/status.ts.
        payments: payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount, state: wirePaymentState(p.state), providerRef: p.providerRef, createdAt: p.createdAt.toISOString() })),
        fulfillments: fulfillments.map((f) => ({
          id: f.id, state: f.state, trackingCode: f.trackingCode, carrier: f.carrier,
          locationId: f.locationId, notifyCustomer: f.notifyCustomer, createdAt: f.createdAt.toISOString(),
          lines: fulfillmentLines.filter((fl) => fl.fulfillmentId === f.id).map((fl) => ({ orderLineId: fl.orderLineId, quantity: fl.quantity })),
        })),
        // Per-line refund history: amount + restock so the admin can see
        // exactly what was refunded/restocked, not just a lump order-level sum.
        refunds: refunds.map((r) => ({
          id: r.id, state: r.state, amount: r.amount, itemsAmount: r.itemsAmount, shippingAmount: r.shippingAmount,
          reason: r.reason, createdAt: r.createdAt.toISOString(),
          lines: refundLines.filter((rl) => rl.refundId === r.id).map((rl) => ({ orderLineId: rl.orderLineId, quantity: rl.quantity, amount: rl.amount, restock: rl.restock })),
        })),
        locations: locations.map((l) => ({ id: l.id, name: l.name, code: l.code, isDefault: l.isDefault })),
        // `data` carries internal-note text (action === 'note') — everything
        // else ignores it. Reusing audit_log keeps notes in the SAME timeline
        // as every other order event instead of a second, disconnected feed.
        events: events.map((e) => ({ id: e.id, action: e.action, fromState: e.fromState, toState: e.toState, actor: e.actor, at: e.at.toISOString(), data: e.action === 'note' ? e.data : undefined })),
      };
    });
    if (!out) throw new HttpError(404, 'order not found');
    return c.json(out, 200);
  }),
);

// ── internal notes (staff-only, never shown to the customer) ────────────────
// Reuses audit_log (entity='order', action='note') instead of a new table:
// the order-detail timeline already reads audit_log for every other event, so
// a note appears in the SAME chronological feed as fulfillment/refund/cancel
// entries with zero extra joins. `data.note` is the only field the timeline
// reader treats specially for action==='note' (see GET /orders/{code} above).
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/notes', summary: 'Add an internal note to the order timeline (staff-only)',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ note: z.string().trim().min(1).max(2000) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { code } = c.req.valid('param');
    const { note } = c.req.valid('json');
    const id = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return null;
      const [row] = await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'note', data: { note } }).returning({ id: s.auditLog.id });
      return row!.id;
    });
    if (!id) throw new HttpError(404, 'order not found');
    return c.json({ id }, 200);
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
    let stockChanged = false;
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
          const ship = l.quantity - l.fulfilledQty - l.cancelledQty;
          if (ship <= 0) continue;
          await tx.update(s.orderLine).set({ fulfilledQty: l.quantity - l.cancelledQty }).where(eq(s.orderLine.id, l.id));
          if (l.variantId) {
            await tx.update(s.stock).set({
              onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`,
              allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)`,
            }).where(eq(s.stock.variantId, l.variantId));
            await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: o.id, actor: admin.email });
            stockChanged = true;
          }
        }
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'fulfill', toState: state });
      // WP2: emit order.shipped (existing webhook pattern) + durable customer
      // email via the outbox. Only on the first Shipped transition so we don't
      // double-email a re-fulfill that just refreshes tracking. Webhook emit,
      // email enqueue and the Shipped state all commit in the same txn — SR-12:
      // the notification can no longer be lost to an SMTP blip after the state
      // committed (the old inline send failed silently).
      // Webhook fires for ALL orders (3rd-party fulfillment/analytics subscribers);
      // the customer email is gated on customerId (nullable FK → eq() needs guard).
      if (state === 'Shipped' && advancingToShipped) {
        await emitEvent(tx, st.storeId, 'order.shipped', { code, trackingCode: trackingCode ?? null, carrier: carrier ?? null });
        if (o.customerId) {
          const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
          if (cust?.email) {
            const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
            // SR-05: per-store sender + storefront URL from store.config.
            await enqueueShippingNotification(tx, st.storeId,
              { name: st.name, currency: st.currency, config: storeRow?.config ?? null },
              cust.email,
              { code, trackingCode: trackingCode ?? null, carrier: carrier ?? null, dedupeKey: `shipping_notification:${o.id}:Shipped` });
          }
        }
      }
      return { kind: 'ok' as const, fid, state };
    });
    if (stockChanged) onStockChanged(st.slug);
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `order not fulfillable in state ${res.state}`);
    if (res.kind === 'regress') throw new HttpError(409, `cannot move fulfillment from ${res.state} back to Shipped`);
    return c.json({ code, fulfillment: res.state }, 200);
  }),
);

// ── partial fulfillment (admin-essentials) ───────────────────────────────────
// Ships a SUBSET of an order's lines/quantities as their own fulfillment
// record, distinct from POST /fulfill above (which is all-or-nothing and
// stays as-is for the CSV/bulk-import callers that already depend on it).
// Multiple calls create multiple fulfillment rows — e.g. a 3-item order that
// ships in two boxes from two locations is two rows here, each with its own
// tracking/carrier/location and its own fulfillment_line quantities.
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/fulfillments', summary: 'Create a fulfillment for selected lines/quantities (partial fulfillment)',
    request: {
      params: z.object({ code: z.string() }),
      body: {
        content: J(z.object({
          lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1),
          locationId: z.string().uuid().optional(),
          trackingCode: z.string().optional(),
          carrier: z.string().optional(),
          notifyCustomer: z.boolean().default(true),
        })),
      },
    },
    responses: {
      200: { description: 'OK', content: J(z.object({ code: z.string(), fulfillmentId: z.string(), state: z.string() })) },
      404: { description: 'Not found', ...errBody },
      409: { description: 'Conflict', ...errBody },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { code } = c.req.valid('param');
    const body = c.req.valid('json');
    let stockChanged = false;
    const variantIdsTouched: string[] = [];
    type Res =
      | { kind: 'ok'; fulfillmentId: string }
      | { kind: 'notfound' }
      | { kind: 'badstate'; state: string }
      | { kind: 'badlines' }
      | { kind: 'badlocation' };
    const res: Res = await withStore(st.storeId, async (tx): Promise<Res> => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
      if (!o) return { kind: 'notfound' };
      if (o.state !== 'Paid' && o.state !== 'PartiallyRefunded') return { kind: 'badstate', state: o.state };
      if (body.locationId) {
        const [loc] = await tx.select({ id: s.location.id }).from(s.location)
          .where(and(eq(s.location.id, body.locationId), eq(s.location.storeId, st.storeId), eq(s.location.enabled, true))).limit(1);
        if (!loc) return { kind: 'badlocation' };
      }
      const orderLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id)).for('update');
      const byId = new Map(orderLines.map((l) => [l.id, l]));
      const seen = new Set<string>();
      for (const line of body.lines) {
        if (seen.has(line.orderLineId)) return { kind: 'badlines' };
        seen.add(line.orderLineId);
        const row = byId.get(line.orderLineId);
        if (!row || row.orderId !== o.id) return { kind: 'badlines' };
        const remaining = row.quantity - row.fulfilledQty - row.cancelledQty;
        if (line.quantity > remaining) return { kind: 'badlines' };
      }
      const [f] = await tx.insert(s.fulfillment).values({
        storeId: st.storeId, orderId: o.id, state: 'Shipped',
        trackingCode: body.trackingCode ?? null, carrier: body.carrier ?? null,
        locationId: body.locationId ?? null, notifyCustomer: body.notifyCustomer,
      }).returning({ id: s.fulfillment.id });
      const fulfillmentId = f!.id;
      await tx.insert(s.fulfillmentLine).values(body.lines.map((l) => ({ storeId: st.storeId, fulfillmentId, orderLineId: l.orderLineId, quantity: l.quantity })));
      for (const line of body.lines) {
        const row = byId.get(line.orderLineId)!;
        await tx.update(s.orderLine).set({ fulfilledQty: sql`${s.orderLine.fulfilledQty} + ${line.quantity}` }).where(eq(s.orderLine.id, row.id));
        if (row.variantId) {
          await tx.update(s.stock).set({
            onHand: sql`greatest(${s.stock.onHand} - ${line.quantity}, 0)`,
            allocated: sql`greatest(${s.stock.allocated} - ${line.quantity}, 0)`,
          }).where(eq(s.stock.variantId, row.variantId));
          await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: row.variantId, delta: -line.quantity, reason: 'fulfillment', refOrderId: o.id, actor: admin.email });
          if (body.locationId) {
            await tx.update(s.stockLocation).set({ onHand: sql`greatest(${s.stockLocation.onHand} - ${line.quantity}, 0)` })
              .where(and(eq(s.stockLocation.variantId, row.variantId), eq(s.stockLocation.locationId, body.locationId)));
          }
          stockChanged = true;
          variantIdsTouched.push(row.variantId);
        }
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'fulfill', toState: 'Shipped', data: { partial: true, fulfillmentId, lines: body.lines.length, locationId: body.locationId ?? null } });
      // Webhook fires unconditionally (3rd-party subscribers care about every
      // shipment); the CUSTOMER email is the thing notifyCustomer gates. Each
      // fulfillment gets its own dedupeKey (keyed on fulfillmentId, not
      // orderId:Shipped like the whole-order route) — a second partial
      // shipment on the same order must send its own email, not be treated as
      // a duplicate of the first.
      await emitEvent(tx, st.storeId, 'order.shipped', { code, trackingCode: body.trackingCode ?? null, carrier: body.carrier ?? null, partial: true });
      if (body.notifyCustomer && o.customerId) {
        const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
        if (cust?.email) {
          const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
          await enqueueShippingNotification(tx, st.storeId,
            { name: st.name, currency: st.currency, config: storeRow?.config ?? null },
            cust.email,
            { code, trackingCode: body.trackingCode ?? null, carrier: body.carrier ?? null, dedupeKey: `shipping_notification:${fulfillmentId}:Shipped` });
        }
      }
      return { kind: 'ok', fulfillmentId };
    });
    if (stockChanged) onStockChanged(st.slug, [...new Set(variantIdsTouched)]);
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `order not fulfillable in state ${res.state}`);
    if (res.kind === 'badlocation') throw new HttpError(409, 'location not found or disabled');
    if (res.kind === 'badlines') throw new HttpError(409, 'duplicate, foreign, or over-quantity line in fulfillment request');
    return c.json({ code, fulfillmentId: res.fulfillmentId, state: 'Shipped' }, 200);
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
      let stockChanged = false;
      const res = await withStore(st.storeId, async (tx): Promise<{ kind: 'ok' | 'notfound' | 'badstate' | 'regress'; state?: string }> => {
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
            const ship = l.quantity - l.fulfilledQty - l.cancelledQty;
            if (ship <= 0) continue;
            await tx.update(s.orderLine).set({ fulfilledQty: l.quantity - l.cancelledQty }).where(eq(s.orderLine.id, l.id));
            if (l.variantId) {
              await tx.update(s.stock).set({
                onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`,
                allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)`,
              }).where(eq(s.stock.variantId, l.variantId));
              await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: order.id, actor: admin.email });
              stockChanged = true;
            }
          }
        }
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: order.id, action: 'fulfill', toState: o.state });
        // SR-12: shipping notification is enqueued in the SAME txn as the
        // Shipped transition (durable retry, no post-commit silent drop).
        if (o.state === 'Shipped' && advancingToShipped) {
          await emitEvent(tx, st.storeId, 'order.shipped', { code: o.code, trackingCode: o.trackingCode ?? null, carrier: o.carrier ?? null });
          if (order.customerId) {
            const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1);
            if (cust?.email) {
              const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
              await enqueueShippingNotification(tx, st.storeId,
                { name: st.name, currency: st.currency, config: storeRow?.config ?? null },
                cust.email,
                { code: o.code, trackingCode: o.trackingCode ?? null, carrier: o.carrier ?? null, dedupeKey: `shipping_notification:${order.id}:Shipped` });
            }
          }
        }
        return { kind: 'ok', state: o.state };
      });
      if (stockChanged) onStockChanged(st.slug);
      if (res.kind === 'ok') {
        results.push({ code: o.code, ok: true, fulfillment: res.state });
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
    let stockChanged = false;
    const res = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
      if (!o) return { kind: 'notfound' as const };
      // Only unpaid orders can be cancelled directly — cancelling releases stock
      // but does not touch money. A Paid order must go through Refund so the
      // payment (and any issued licenses) are handled explicitly.
      if (await hasUnresolvedPayment(tx, o.id)) throw new HttpError(409, 'Resolve the pending payment before cancelling');
      if (o.state !== 'PendingPayment') return { kind: 'paid' as const, state: o.state };
      if (!canTransition(o.state as OrderState, 'Cancelled')) return { kind: 'badstate' as const, state: o.state };
      // Release stock still reserved for unshipped units. Shipped units already
      // had their allocation released (see fulfill), so release = unfulfilled qty.
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      for (const l of lines) {
        const release = l.quantity - l.fulfilledQty - l.cancelledQty;
        if (release > 0) {
          // D6: mark released units cancelled so a later refund can't release them again.
          await tx.update(s.orderLine).set({ cancelledQty: sql`${s.orderLine.cancelledQty} + ${release}` }).where(eq(s.orderLine.id, l.id));
        }
        if (release > 0 && l.variantId) {
          await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${release}, 0)` })
            .where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
          stockChanged = true;
        }
      }
      await tx.update(s.order).set({ state: 'Cancelled', updatedAt: new Date() }).where(eq(s.order.id, o.id));
      // LOYALTY-1: release points reserved by this order (idempotent).
      await releaseOrderLoyalty(tx, st.storeId, o.id, admin.email);
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'cancel', fromState: o.state, toState: 'Cancelled' });
      return { kind: 'ok' as const };
    });
    if (stockChanged) onStockChanged(st.slug);
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'paid') throw new HttpError(409, `paid order — use Refund (state ${res.state})`);
    if (res.kind === 'badstate') throw new HttpError(409, `cannot cancel order in state ${res.state}`);
    return c.json({ code, state: 'Cancelled' }, 200);
  }),
);
