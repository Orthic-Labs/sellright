import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { withAdvisoryLock, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { guard, HttpError, requireAdmin, requireHuman, requireStore, requireWrite, requirePermission, J, errBody } from './admin-helpers.js';
import { withLockedSet } from '../db/locks.js';
import { overrideRelease, ReservationRuleError } from '../payments/reservation.js';
import { GatewayPaymentError, verifyGatewayAttempt } from '../payments/gateway-payment.js';
import { listPaymentAlerts } from '../payments/payment-alerts.js';
import { listEffectsNeedingAttention, requeueTerminalEffect } from '../payments/settlement/effects.js';
import { approveHeldEditIssuance, IssuanceApprovalError } from '../payments/settlement/issuance-approval.js';
import { reconcileStripeOrder } from '../payments/stripe-reconcile.js';

export const adminGatewayPayments = new OpenAPIHono();

adminGatewayPayments.openapi(createRoute({
  method: 'get', path: '/v1/admin/payment-archives', summary: 'Read retained source payment history (no payment operations)',
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }) },
  responses: {
    200: { description: 'Source facts; importCurrencyContext is not payment currency evidence', content: J(z.object({
      items: z.array(z.object({ id: z.string(), sourceKey: z.string(), sourceId: z.string(), sourceDigest: z.string(),
        sourceCreatedAt: z.string().nullable(), sourceOrderId: z.string().nullable(), method: z.string().nullable(),
        state: z.string().nullable(), amount: z.number().int().nullable(), transactionId: z.string().nullable(),
        importCurrencyContext: z.string(), refundCount: z.number().int(), referenceCount: z.number().int() })),
      total: z.number().int(), limit: z.number().int(), offset: z.number().int(),
    })) },
    401: { description: 'Unauthorized', ...errBody },
  },
}), c => guard(c, async () => {
  const { admin } = await requireAdmin(c);
  const store = requireStore(admin, c);
  requirePermission(store, 'refunds');
  const { limit, offset } = c.req.valid('query');
  const out = await withStore(store.storeId, async tx => {
    const where = eq(s.financialPaymentArchive.storeId, store.storeId);
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(s.financialPaymentArchive).where(where);
    // Deliberately project no metadata, error payload, dependency payload or gateway identity.
    const rows = await tx.select({ id: s.financialPaymentArchive.id, sourceKey: s.financialPaymentArchive.sourceKey,
      sourceId: s.financialPaymentArchive.sourceId, sourceDigest: s.financialPaymentArchive.sourceDigest,
      sourceCreatedAt: s.financialPaymentArchive.sourceCreatedAt, sourceOrderId: s.financialPaymentArchive.sourceOrderId,
      method: s.financialPaymentArchive.method, state: s.financialPaymentArchive.state, amount: s.financialPaymentArchive.amount,
      transactionId: s.financialPaymentArchive.transactionId, importCurrencyContext: s.financialPaymentArchive.importCurrencyContext,
      refundCount: sql<number>`cardinality(${s.financialPaymentArchive.sourceRefunds})`,
      referenceCount: sql<number>`cardinality(${s.financialPaymentArchive.sourceReferences})`,
    }).from(s.financialPaymentArchive).where(where).orderBy(desc(s.financialPaymentArchive.id)).limit(limit).offset(offset);
    return { total: count?.total ?? 0, items: rows };
  });
  return c.json({ ...out, limit, offset }, 200);
}));

adminGatewayPayments.get('/v1/admin/payment-reconciliation', c => guard(c, async () => {
  const { admin } = await requireAdmin(c);
  const store = requireStore(admin, c);
  requirePermission(store, 'refunds');
  const result = await withStore(store.storeId, async tx => ({
    // Stripe intents (operation 'intent') appear here too: 'open' = minted,
    // not yet paid; processing/unknown = in flight / needs review (D1/D5).
    attempts: await tx.select().from(s.paymentAttempt)
      .where(or(
        inArray(s.paymentAttempt.status, ['processing', 'pending', 'unknown']),
        and(eq(s.paymentAttempt.operation, 'intent'), inArray(s.paymentAttempt.status, ['open', 'failed', 'action_required'])),
      ))
      .orderBy(desc(s.paymentAttempt.updatedAt)).limit(100),
    events: await tx.select().from(s.gatewayEvent).where(inArray(s.gatewayEvent.status, ['pending', 'manual']))
      .orderBy(desc(s.gatewayEvent.updatedAt)).limit(100),
    // D3/D4/D9/D14: money that could not be applied automatically.
    alerts: await listPaymentAlerts(tx, 100),
    // Plan 2.8: settlement effects (issuance, renewal extension, loyalty, notification) that
    // exhausted their retries or are held for review — terminal, or retrying after a failure.
    effects: await listEffectsNeedingAttention(tx, 100),
    // D14: settled money on a non-payable (e.g. Cancelled) order — MONEY-4
    // audit rows, so operators can refund or reinstate from one list.
    paymentsAfterCancel: await tx.select({
      id: s.auditLog.id, orderId: s.auditLog.entityId, orderCode: s.order.code,
      orderState: s.order.state, data: s.auditLog.data, createdAt: s.auditLog.at,
    }).from(s.auditLog)
      .leftJoin(s.order, sql`${s.order.id}::text = ${s.auditLog.entityId}`)
      .where(and(eq(s.auditLog.entity, 'order'), eq(s.auditLog.action, 'payment_after_cancel')))
      .orderBy(desc(s.auditLog.at)).limit(100),
  }));
  return c.json(result);
}));

// PAYMENT-TIMING §5.3 (3): operator override of a reservation held by a Cancelled order whose provider state is
// unverified. Releases the order's held rows (released_unverified). Money that lands later follows I1.
const OverrideReleaseBody = z.object({ reason: z.string().trim().min(10).max(500) });
const OverrideReleaseResult = z.object({ released: z.number().int(), orderId: z.string().uuid(), reservationIds: z.array(z.string().uuid()) });
adminGatewayPayments.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/payment-reconciliation/reservations/{id}/override-release',
    summary: 'Operator override: release an order\'s held reservations while provider state is unverified (order must be Cancelled)',
    request: { params: z.object({ id: z.string().uuid() }), body: { content: J(OverrideReleaseBody) } },
    responses: {
      200: { description: 'Released', content: J(OverrideReleaseResult) },
      404: { description: 'Reservation not found', ...errBody },
      409: { description: 'Order is not Cancelled, or nothing is held', ...errBody },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const store = requireStore(admin, c);
    requireWrite(store);
    requirePermission(store, 'refunds');
    const { id } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const [row] = await withStore(store.storeId, (tx) => tx.select({ orderId: s.orderReservation.orderId })
      .from(s.orderReservation).where(and(eq(s.orderReservation.id, id), eq(s.orderReservation.storeId, store.storeId))).limit(1));
    if (!row) throw new HttpError(404, 'Reservation not found');
    const released = await withLockedSet(store.storeId, { kind: 'order', orderId: row.orderId }, async (tx, held) => {
      try {
        return await overrideRelease(tx, held, { storeId: store.storeId, orderId: row.orderId, reason });
      } catch (e) {
        if (e instanceof ReservationRuleError) throw new HttpError(409, e.message);
        throw e;
      }
    });
    if (!released.length) throw new HttpError(409, 'No held reservation to release on this order');
    await withStore(store.storeId, (tx) => tx.insert(s.auditLog).values({
      storeId: store.storeId, actor: admin.email, entity: 'order', entityId: row.orderId, action: 'reservation_override_release',
      data: { reservationIds: released.map((r) => r.id), reason: reason.trim() },
    }));
    return c.json({ released: released.length, orderId: row.orderId, reservationIds: released.map((r) => r.id) }, 200);
  }),
);

// Issue #192: a human's explicit, audited approval of an order-edit issuance that was held (agent-made edit, or a legacy
// edit whose actor cannot be resolved). The retry route above only requeues and reaches the same hold; this records fresh
// authorisation beside the original decision and issues in the same transaction. Same gate as retry (write role + the
// 'refunds' permission), plus human-only (AGENT_DENIED 'entitlement' and requireHuman). No step-up, matching its neighbours
// (effects/:id/retry and reservations/:id/override-release, which move the same entitlements without one).
const ApproveIssuanceResult = z.object({
  effectId: z.string().uuid(), orderId: z.string().uuid(), approved: z.literal(true),
  alreadyApproved: z.boolean().openapi({ description: 'true when the effect already carried an approval; nothing further was issued by this call' }),
  status: z.string().openapi({ description: 'The effect status after the call (done once issued)' }),
});
adminGatewayPayments.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/payment-reconciliation/effects/{id}/approve-issuance',
    summary: 'Human approval of a held order-edit issuance: records the approval (original decision untouched), issues, and closes the review task',
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: 'Approved (or already approved)', content: J(ApproveIssuanceResult) },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Agents, read-only roles and users without the refunds permission are refused', ...errBody },
      404: { description: 'Effect not found', ...errBody },
      409: { description: 'EFFECT_NOT_HELD: not an order-edit effect that is terminal on an issuance hold', ...errBody },
    },
  }),
  (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const store = requireStore(admin, c);
    requireHuman(admin);
    requireWrite(store); requirePermission(store, 'refunds');
    const { id } = c.req.valid('param');
    try {
      const r = await approveHeldEditIssuance(store.storeId, id, { adminUserId: admin.id, email: admin.email });
      return c.json({ effectId: r.effectId, orderId: r.orderId, approved: true as const, alreadyApproved: !r.approvedNow, status: r.status }, 200);
    } catch (e) {
      if (e instanceof IssuanceApprovalError) throw new HttpError(e.status, e.message, e.code);
      throw e;
    }
  }),
);

adminGatewayPayments.post('/v1/admin/payment-reconciliation/effects/:id/retry', c => guard(c, async () => {
  const { admin } = await requireAdmin(c);
  const store = requireStore(admin, c);
  requireWrite(store); requirePermission(store, 'refunds');
  const id = c.req.param('id');
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Effect not found');
  const queued = await withStore(store.storeId, async tx => {
    const ok = await requeueTerminalEffect(tx, id);
    if (ok) await tx.insert(s.auditLog).values({ storeId: store.storeId, actor: admin.email, entity: 'order_pending_effect', entityId: id, action: 'effect_requeued' });
    return ok;
  });
  if (!queued) throw new HttpError(409, 'Effect is not awaiting manual review');
  return c.json({ queued: true });
}));

adminGatewayPayments.post('/v1/admin/payment-reconciliation/:id/verify', c => guard(c, async () => {
  const { admin } = await requireAdmin(c);
  const store = requireStore(admin, c);
  requireWrite(store); requirePermission(store, 'refunds');
  const id = c.req.param('id');
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Payment not found');
  const body = z.object({ providerRef: z.string().min(1).max(200).optional() }).strict()
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw new HttpError(400, 'Invalid reconciliation request');
  const [attempt] = await withStore(store.storeId, tx => tx.select().from(s.paymentAttempt)
    .where(eq(s.paymentAttempt.id, id)).limit(1));
  if (!attempt) throw new HttpError(404, 'Payment not found');
  const [order] = await withStore(store.storeId, tx => tx.select().from(s.order)
    .where(eq(s.order.id, attempt.orderId)).limit(1));
  if (!order) throw new HttpError(404, 'Order not found');
  // A session response can be lost before its UUID is persisted. An operator
  // may supply the dashboard UUID; provider verification still binds its
  // immutable reference, account, amount and currency before accepting money.
  if (body.data.providerRef) await withAdvisoryLock('pay:' + store.storeId + ':' + order.code, () =>
    withStore(store.storeId, async tx => {
      const [current] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, id)).limit(1).for('update');
      if (!current || !['nmi', 'sezzle'].includes(current.method)) throw new HttpError(409, 'Unsupported reconciliation');
      if (current.providerRef && current.providerRef !== body.data.providerRef) throw new HttpError(409, 'Payment reference is immutable');
      await tx.update(s.paymentAttempt).set({ providerRef: body.data.providerRef, updatedAt: new Date() })
        .where(eq(s.paymentAttempt.id, id));
      await tx.insert(s.auditLog).values({ storeId: store.storeId, actor: admin.email,
        entity: 'payment_attempt', entityId: id, action: 'bind_provider_reference',
        data: { providerRef: body.data.providerRef } });
    }));
  try {
    const result = await verifyGatewayAttempt(store.storeId, id);
    await withStore(store.storeId, tx => tx.insert(s.auditLog).values({
      storeId: store.storeId, actor: admin.email, entity: 'payment_attempt', entityId: id,
      action: 'verify_gateway', data: { status: result.status },
    }));
    return c.json(result);
  } catch (error) {
    if (error instanceof GatewayPaymentError) throw new HttpError(error.status === 503 ? 502 : error.status, error.message);
    throw error;
  }
}));

adminGatewayPayments.post('/v1/admin/payment-reconciliation/events/:id/retry', c => guard(c, async () => {
  const { admin } = await requireAdmin(c);
  const store = requireStore(admin, c);
  requireWrite(store); requirePermission(store, 'refunds');
  const id = c.req.param('id');
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Event not found');
  const rows = await withStore(store.storeId, tx => tx.update(s.gatewayEvent)
    .set({ status: 'pending', attempts: 0, lastError: null, updatedAt: new Date() })
    .where(and(eq(s.gatewayEvent.id, id), eq(s.gatewayEvent.status, 'manual'))).returning({ id: s.gatewayEvent.id }));
  if (!rows.length) throw new HttpError(409, 'Event is not awaiting manual review');
  return c.json({ queued: true });
}));

// D1: operator-triggered Stripe settlement fallback for one order — retrieves
// each tracked PaymentIntent from Stripe and applies it through the webhook's
// idempotent path.
adminGatewayPayments.post('/v1/admin/payment-reconciliation/orders/:code/stripe-reconcile', c => guard(c, async () => {
  const { admin } = await requireAdmin(c);
  const store = requireStore(admin, c);
  requireWrite(store); requirePermission(store, 'refunds');
  const code = c.req.param('code');
  const result = await reconcileStripeOrder(store.storeId, { code }, { actor: admin.email, discover: true });
  if (!result.found) throw new HttpError(404, 'Order not found');
  await withStore(store.storeId, tx => tx.insert(s.auditLog).values({
    storeId: store.storeId, actor: admin.email, entity: 'order', entityId: code, action: 'stripe_reconcile',
    data: { state: result.state ?? null, intents: result.intents },
  }));
  return c.json(result);
}));
