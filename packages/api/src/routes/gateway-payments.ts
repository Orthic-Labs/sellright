import { createHash } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { customerToken } from '../auth/session.js';
import { clientIp, attemptRetryAfter } from '../auth/rate-limit.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveStoreFromCtx } from './store-context.js';
import { gatewayAccount } from '../payments/gateway-account.js';
import { normalizeSezzleEvent, verifySezzleSignature } from '../payments/sezzle.js';
import { recordDispute } from '../disputes/disputes.js';
import {
  GatewayPaymentError, startGatewayPayment, readGatewayAttempt, verifyGatewayAttempt,
} from '../payments/gateway-payment.js';

export const gatewayPayments = new OpenAPIHono();
gatewayPayments.use('/v1/webhooks/sezzle/*', bodyLimit({ maxSize: 262144 }));
const requestSchema = z.object({
  method: z.enum(['nmi', 'sezzle']),
  token: z.string().min(1).max(4096).optional(),
}).strict();

gatewayPayments.post('/v1/shop/orders/:code/gateway-payment', async c => {
  const st = await resolveStoreFromCtx(c);
  const retry = attemptRetryAfter(clientIp(c), 'gateway:' + clientIp(c));
  if (retry) return c.json({ error: 'Too many payment attempts' }, 429);
  const key = c.req.header('idempotency-key');
  if (!key || key.length > 200) return c.json({ error: 'Idempotency-Key required (maximum 200 characters)' }, 400);
  const body = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid payment request' }, 400);
  try {
    const result = await startGatewayPayment({
      storeId: st.id, code: c.req.param('code'), config: st.config,
      ...body.data, idempotencyKey: key, receiptToken: c.req.header('x-receipt-token'),
      customerSession: customerToken(c),
    });
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof GatewayPaymentError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

gatewayPayments.post('/v1/shop/orders/:code/gateway-payment/:attempt/verify', async c => {
  const st = await resolveStoreFromCtx(c);
  const retry = attemptRetryAfter(clientIp(c), 'gateway-verify:' + clientIp(c));
  if (retry) return c.json({ error: 'Too many verification attempts' }, 429);
  try {
    const input = { storeId: st.id, code: c.req.param('code'), id: c.req.param('attempt'),
      receiptToken: c.req.header('x-receipt-token'), customerSession: customerToken(c) };
    if (!z.string().uuid().safeParse(input.id).success) return c.json({ error: 'Payment not found' }, 404);
    await readGatewayAttempt(input);
    return c.json(await verifyGatewayAttempt(st.id, input.id), 200);
  } catch (error) {
    if (error instanceof GatewayPaymentError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// Signature selects the configured account. Request headers never select another tenant.
gatewayPayments.post('/v1/webhooks/sezzle/:storeId/:accountId', async c => {
  const storeId = c.req.param('storeId');
  if (!z.string().uuid().safeParse(storeId).success) return c.json({ error: 'Unknown account' }, 404);
  let account;
  try { account = gatewayAccount(storeId, 'sezzle', c.req.param('accountId')); }
  catch { return c.json({ error: 'Unknown account' }, 404); }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > 262144) return c.json({ error: 'Payload too large' }, 413);
  if (!verifySezzleSignature(raw, c.req.header('sezzle-signature'), account.privateKey!)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return c.json({ error: 'Invalid event' }, 400); }
  // SR-06: per-event normalization, not one universal schema — documented
  // dispute events carry data.order_uuid (no data.uuid). A correctly signed
  // dispute must never 400 on that. Non-envelopes (no uuid AND no event) are
  // the only 400; everything else is durably recorded for the reconcile
  // worker (it parks non-order events as 'manual' for operators).
  const normalized = normalizeSezzleEvent(payload);
  if (!normalized) return c.json({ error: 'Invalid event' }, 400);
  // A signed event with no envelope uuid still lands durably — dedupe keys on
  // the exact body hash so a provider redelivery collapses to the same row.
  const eventId = normalized.eventId ??
    ('body:' + createHash('sha256').update(raw).digest('hex').slice(0, 48));
  await withStore(storeId, async tx => {
    await tx.insert(s.gatewayEvent).values({
      storeId, method: 'sezzle', accountId: account.accountId, mode: account.mode,
      eventId, eventType: normalized.eventType, providerRef: normalized.providerRef,
      // Persist normalized identity only; provider GET is authoritative for
      // money and status.
      details: normalized.details,
    }).onConflictDoNothing();
    // Dispute events also land in the canonical dispute table (operator email
    // + audit + order linkage). Deliberately no auto-refund/cancel — disputes
    // need human handling; recordDispute dedupes on (store, provider, ref).
    if (normalized.disputeId || normalized.details.dispute) {
      const [pay] = normalized.orderUuid ? await tx
        .select({ id: s.payment.id, orderId: s.payment.orderId })
        .from(s.payment)
        .where(and(eq(s.payment.providerRef, normalized.orderUuid), eq(s.payment.method, 'sezzle')))
        .limit(1) : [];
      const [ord] = pay ? await tx.select({ code: s.order.code }).from(s.order)
        .where(eq(s.order.id, pay.orderId)).limit(1) : [];
      const d = normalized.details.dispute as Record<string, unknown> | undefined;
      await recordDispute(tx, storeId, {
        provider: 'sezzle',
        providerRef: `sezzle:${normalized.orderUuid ?? 'unknown'}:${normalized.disputeId ?? eventId}`,
        paymentId: pay?.id ?? null, orderId: pay?.orderId ?? null, orderCode: ord?.code ?? null,
        amountCents: typeof d?.amountInCents === 'number' ? d.amountInCents : null,
        currency: typeof d?.currency === 'string' ? d.currency : null,
        reason: typeof d?.disputeType === 'string' ? d.disputeType : normalized.eventType,
        status: typeof d?.disputeStatus === 'string' ? d.disputeStatus : 'open',
        details: { eventId, eventType: normalized.eventType, dueDate: d?.dueDate ?? null },
        actor: 'sezzle:webhook',
      });
    }
  });
  return c.json({ received: true }, 200);
});
