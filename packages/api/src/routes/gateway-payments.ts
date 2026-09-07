import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { customerToken } from '../auth/session.js';
import { clientIp, loginRetryAfter } from '../auth/rate-limit.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveStoreFromCtx } from './store-context.js';
import { gatewayAccount } from '../payments/gateway-account.js';
import { verifySezzleSignature } from '../payments/sezzle.js';
import {
  GatewayPaymentError, startGatewayPayment, readGatewayAttempt, verifySezzleAttempt,
} from '../payments/gateway-payment.js';

export const gatewayPayments = new OpenAPIHono();
const requestSchema = z.object({
  method: z.enum(['nmi', 'sezzle']),
  token: z.string().min(1).max(4096).optional(),
}).strict();

gatewayPayments.post('/v1/shop/orders/:code/gateway-payment', async c => {
  const st = await resolveStoreFromCtx(c);
  const retry = loginRetryAfter(clientIp(c), 'gateway:' + clientIp(c));
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
  const retry = loginRetryAfter(clientIp(c), 'gateway-verify:' + clientIp(c));
  if (retry) return c.json({ error: 'Too many verification attempts' }, 429);
  try {
    const input = { storeId: st.id, code: c.req.param('code'), id: c.req.param('attempt'),
      receiptToken: c.req.header('x-receipt-token'), customerSession: customerToken(c) };
    if (!z.string().uuid().safeParse(input.id).success) return c.json({ error: 'Payment not found' }, 404);
    const current = await readGatewayAttempt(input);
    return c.json(current.method === 'sezzle'
      ? await verifySezzleAttempt(st.id, input.id) : current, 200);
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
  const body = z.object({
    uuid: z.string().min(1).max(200),
    event: z.string(),
    data: z.object({ uuid: z.string() }).passthrough(),
  }).safeParse(JSON.parse(raw));
  if (!body.success) return c.json({ error: 'Invalid event' }, 400);
  const [attempt] = await withStore(storeId, tx => tx.select().from(s.paymentAttempt).where(and(
    eq(s.paymentAttempt.accountId, account.accountId), eq(s.paymentAttempt.mode, account.mode),
    eq(s.paymentAttempt.method, 'sezzle'), eq(s.paymentAttempt.providerRef, body.data.data.uuid),
    eq(s.paymentAttempt.operation, 'session'),
  )).limit(1));
  // The event can beat the session response commit. Return retryable failure;
  // never acknowledge an event for which no durable association exists yet.
  if (!attempt) return c.json({ error: 'Payment association pending' }, 503);
  const eventId = 'sezzle:' + account.accountId + ':' + body.data.uuid;
  const [seen] = await withStore(storeId, tx => tx.select({ id: s.processedEvent.id }).from(s.processedEvent)
    .where(and(eq(s.processedEvent.id, eventId), eq(s.processedEvent.storeId, storeId))).limit(1));
  if (seen) return c.json({ received: true }, 200);
  if (!['order.authorized', 'order.captured'].includes(body.data.event)) {
    return c.json({ error: 'Event requires operator reconciliation' }, 503);
  }
  try {
    const result = await verifySezzleAttempt(storeId, attempt.id);
    if (result.status === 'unknown') return c.json({ error: 'Verification unavailable' }, 503);
    await withStore(storeId, tx => tx.insert(s.processedEvent).values({
      id: eventId, storeId, type: 'sezzle-webhook',
    }).onConflictDoNothing());
    return c.json({ received: true }, 200);
  } catch { return c.json({ error: 'Reconciliation unavailable' }, 503); }
});
