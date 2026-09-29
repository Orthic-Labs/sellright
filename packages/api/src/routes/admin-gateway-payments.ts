import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { withAdvisoryLock, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { guard, HttpError, requireAdmin, requireStore, requireWrite, requirePermission } from './admin-helpers.js';
import { GatewayPaymentError, verifyGatewayAttempt } from '../payments/gateway-payment.js';
import { listPaymentAlerts } from '../payments/payment-alerts.js';
import { reconcileStripeOrder } from '../payments/stripe-reconcile.js';

export const adminGatewayPayments = new OpenAPIHono();

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
        and(eq(s.paymentAttempt.operation, 'intent'), inArray(s.paymentAttempt.status, ['open', 'failed'])),
      ))
      .orderBy(desc(s.paymentAttempt.updatedAt)).limit(100),
    events: await tx.select().from(s.gatewayEvent).where(inArray(s.gatewayEvent.status, ['pending', 'manual']))
      .orderBy(desc(s.gatewayEvent.updatedAt)).limit(100),
    // D3/D4/D9/D14: money that could not be applied automatically.
    alerts: await listPaymentAlerts(tx, 100),
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
  const result = await reconcileStripeOrder(store.storeId, { code }, { actor: admin.email });
  if (!result.found) throw new HttpError(404, 'Order not found');
  await withStore(store.storeId, tx => tx.insert(s.auditLog).values({
    storeId: store.storeId, actor: admin.email, entity: 'order', entityId: code, action: 'stripe_reconcile',
    data: { state: result.state ?? null, intents: result.intents },
  }));
  return c.json(result);
}));
