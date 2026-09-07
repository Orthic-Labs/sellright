import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { withAdvisoryLock, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveCustomer } from '../auth/session.js';
import { amountDueForOrder, applyPaymentResult } from './settle.js';
import { getProvider, isPaymentMethodEnabled, type PaymentResult } from './provider.js';
import { configuredGatewayAccount, gatewayAccount, gatewayIdentity, type GatewayMethod } from './gateway-account.js';
import { sezzleProvider } from './sezzle.js';
import { prepareSezzleSession } from './session-input.js';
import { queryNmiPayment } from './nmi-query.js';

export class GatewayPaymentError extends Error {
  constructor(public status: 400 | 404 | 409 | 503, message: string) { super(message); }
}
export function receiptMatches(given: string | undefined, expected: string | null): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function ownedOrder(tx: Tx, code: string, receipt?: string, customerSession?: string | null) {
  const [order] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
  if (!order || order.deletedAt) throw new GatewayPaymentError(404, 'Order not found');
  let granted = receiptMatches(receipt, order.receiptToken);
  if (!granted && customerSession && order.customerId) {
    const customer = await resolveCustomer(tx, customerSession);
    granted = customer?.id === order.customerId;
  }
  if (!granted) throw new GatewayPaymentError(404, 'Order not found');
  return order;
}
function view(attempt: typeof s.paymentAttempt.$inferSelect) {
  return { attemptId: attempt.id, status: attempt.status,
    ...(attempt.result as { checkoutUrl?: string; state?: string } | null ?? {}) };
}

export async function startGatewayPayment(input: {
  storeId: string; code: string; method: GatewayMethod; config: unknown;
  idempotencyKey: string; receiptToken?: string; customerSession?: string | null; token?: string;
}) {
  if (!isPaymentMethodEnabled(input.config, input.method)) throw new GatewayPaymentError(409, 'Payment method disabled');
  let account;
  try { account = configuredGatewayAccount(input.storeId, input.method, input.config); }
  catch { throw new GatewayPaymentError(503, 'Payment account is not configured'); }
  const operation = input.method === 'sezzle' ? 'session' : 'charge';
  return withAdvisoryLock('pay:' + input.storeId + ':' + input.code, async () => {
    const prepared = await withStore(input.storeId, async tx => {
      const order = await ownedOrder(tx, input.code, input.receiptToken, input.customerSession);
      const [existing] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        if (existing.orderId !== order.id || existing.method !== input.method || existing.operation !== operation ||
            existing.accountId !== account.accountId || existing.mode !== account.mode) {
          throw new GatewayPaymentError(409, 'Idempotency key belongs to a different payment');
        }
        return { existing };
      }
      if (order.state !== 'PendingPayment') throw new GatewayPaymentError(409, 'Order is not payable');
      const [active] = await tx.select({ id: s.paymentAttempt.id }).from(s.paymentAttempt)
        .where(and(eq(s.paymentAttempt.orderId, order.id), inArray(s.paymentAttempt.status, ['processing','unknown','pending']))).limit(1);
      if (active) throw new GatewayPaymentError(409, 'Resolve the existing payment before starting another');
      const amount = await amountDueForOrder(tx, input.storeId, order.id, order.grandTotal);
      if (amount <= 0) throw new GatewayPaymentError(409, 'Order is already paid');
      if (input.method === 'nmi' && !input.token) throw new GatewayPaymentError(400, 'Payment token required');
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, order.id));
      const [customer] = order.customerId
        ? await tx.select().from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1) : [];
      const attemptId = randomUUID();
      let session;
      if (input.method === 'sezzle') {
        try {
          session = prepareSezzleSession({ order, lines, account, amount, attemptId, customer,
            storefrontUrl: (input.config as { storefrontUrl?: string } | null)?.storefrontUrl });
        } catch (error) {
          throw new GatewayPaymentError(400, error instanceof Error ? error.message : 'Invalid checkout details');
        }
      }
      const context = gatewayIdentity(account);
      const fingerprint = createHash('sha256').update(JSON.stringify({
        orderId: order.id, operation, amount, currency: order.currency, ...context,
      })).digest('hex');
      const [attempt] = await tx.insert(s.paymentAttempt).values({
        id: attemptId, storeId: input.storeId, orderId: order.id, operation, method: input.method,
        accountId: account.accountId, mode: account.mode, amount, currency: order.currency,
        idempotencyKey: input.idempotencyKey, fingerprint, context,
      }).returning();
      return { attempt: attempt!, order, session };
    });
    if ('existing' in prepared) return view(prepared.existing!);
    const { attempt, order, session } = prepared;
    const common = { storeId: input.storeId, orderCode: input.code, amount: attempt.amount,
      currency: attempt.currency, attemptId: attempt.id, gateway: account };
    if (input.method === 'sezzle') {
      try {
        const result = await sezzleProvider.createSession(session!);
        return withStore(input.storeId, async tx => {
          const [updated] = await tx.update(s.paymentAttempt).set({
            status: 'pending', providerRef: result.providerRef,
            result: { checkoutUrl: result.checkoutUrl }, updatedAt: new Date(),
          }).where(eq(s.paymentAttempt.id, attempt.id)).returning();
          return view(updated!);
        });
      } catch {
        await markUnknown(input.storeId, attempt.id, 'Sezzle session requires reconciliation');
        throw new GatewayPaymentError(409, 'Sezzle session could not be confirmed; contact the store');
      }
    }
    const result = await getProvider('nmi')!.createPayment({
      ...common, token: input.token, billingAddress: (order.billingAddress ?? order.shippingAddress ?? {}) as Record<string, unknown>,
    });
    return finishAttempt(input.storeId, attempt.id, result);
  });
}

async function markUnknown(storeId: string, id: string, reason: string) {
  await withStore(storeId, async tx => {
    await tx.update(s.paymentAttempt).set({
      status: 'unknown', result: { error: reason }, updatedAt: new Date(),
    }).where(eq(s.paymentAttempt.id, id));
  });
}

export async function finishAttempt(storeId: string, id: string, result: PaymentResult) {
  return withStore(storeId, async tx => {
    const [attempt] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, id)).limit(1).for('update');
    if (!attempt) throw new GatewayPaymentError(404, 'Payment not found');
    if (attempt.status === 'settled') return view(attempt);
    const [order] = await tx.select().from(s.order).where(eq(s.order.id, attempt.orderId)).limit(1).for('update');
    if (!order) throw new GatewayPaymentError(404, 'Order not found');
    const metadata = {
      ...(result.metadata as Record<string, unknown> | null ?? {}),
      gateway: { accountId: attempt.accountId, storeId, method: attempt.method, mode: attempt.mode },
    };
    const applied = result.providerRef ? await applyPaymentResult(tx, {
      storeId, order, method: attempt.method, result: { ...result, metadata }, amount: attempt.amount,
    }) : { orderState: order.state, paymentState: result.state };
    const status = result.state === 'Settled' ? 'settled'
      : result.state === 'Failed' || result.state === 'Declined' ? 'failed'
      : (result.metadata as Record<string, unknown> | null)?.needsReconciliation ? 'unknown' : 'pending';
    const [updated] = await tx.update(s.paymentAttempt).set({
      status, providerRef: result.providerRef,
      result: { state: applied.orderState, payment: result.state,
        ...(status === 'unknown' ? { error: 'Payment requires reconciliation' } : {}) },
      updatedAt: new Date(),
    }).where(eq(s.paymentAttempt.id, id)).returning();
    return view(updated!);
  });
}

export async function verifySezzleAttempt(storeId: string, id: string) {
  const [attempt] = await withStore(storeId, tx =>
    tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, id)).limit(1));
  if (!attempt || attempt.method !== 'sezzle' || !attempt.providerRef) throw new GatewayPaymentError(404, 'Sezzle payment not found');
  const [order] = await withStore(storeId, tx =>
    tx.select({ code: s.order.code }).from(s.order).where(eq(s.order.id, attempt.orderId)).limit(1));
  if (!order) throw new GatewayPaymentError(404, 'Order not found');
  return withAdvisoryLock('pay:' + storeId + ':' + order.code, async () => {
    const account = gatewayAccount(storeId, 'sezzle', attempt.accountId, attempt.mode as 'test' | 'live');
    const result = await sezzleProvider.createPayment({
      storeId, orderCode: order.code,
      attemptId: (attempt.context as { orderReference?: string } | null)?.orderReference ?? id, amount: attempt.amount,
      currency: attempt.currency, gateway: account, token: attempt.providerRef,
    });
    return finishAttempt(storeId, id, result);
  });
}

export async function readGatewayAttempt(input: {
  storeId: string; code: string; id: string; receiptToken?: string; customerSession?: string | null;
}) {
  return withStore(input.storeId, async tx => {
    const order = await ownedOrder(tx, input.code, input.receiptToken, input.customerSession);
    const [attempt] = await tx.select().from(s.paymentAttempt)
      .where(and(eq(s.paymentAttempt.id, input.id), eq(s.paymentAttempt.orderId, order.id))).limit(1);
    if (!attempt) throw new GatewayPaymentError(404, 'Payment not found');
    return { ...view(attempt), method: attempt.method };
  });
}

export async function verifyGatewayAttempt(storeId: string, id: string) {
  const [attempt] = await withStore(storeId, tx => tx.select().from(s.paymentAttempt)
    .where(eq(s.paymentAttempt.id, id)).limit(1));
  if (!attempt) throw new GatewayPaymentError(404, 'Payment not found');
  if (attempt.operation === 'refund') throw new GatewayPaymentError(409, 'Use refund reconciliation for this attempt');
  if (attempt.method === 'sezzle') return verifySezzleAttempt(storeId, id);
  if (attempt.method !== 'nmi' || attempt.operation !== 'charge') {
    throw new GatewayPaymentError(409, 'This operation requires separate reconciliation');
  }
  const [order] = await withStore(storeId, tx => tx.select().from(s.order)
    .where(eq(s.order.id, attempt.orderId)).limit(1));
  if (!order) throw new GatewayPaymentError(404, 'Order not found');
  return withAdvisoryLock('pay:' + storeId + ':' + order.code, async () => {
    const account = gatewayAccount(storeId, 'nmi', attempt.accountId, attempt.mode as 'test' | 'live');
    const result = await queryNmiPayment({ account, amount: attempt.amount, currency: attempt.currency,
      orderReference: (attempt.context as { orderReference?: string } | null)?.orderReference ?? attempt.id,
      providerRef: attempt.providerRef });
    return finishAttempt(storeId, id, result);
  });
}
