import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { customerToken } from '../auth/session.js';
import { clientIp, attemptRetryAfter } from '../auth/rate-limit.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveStoreFromCtx } from './store-context.js';
import { gatewayAccount } from '../payments/gateway-account.js';
import { verifySezzleSignature } from '../payments/sezzle.js';
import {
  GatewayPaymentError, startGatewayPayment, readGatewayAttempt, verifySezzleAttempt,
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
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return c.json({ error: 'Invalid event' }, 400); }
  const body = z.object({
    uuid: z.string().min(1).max(200),
    event: z.string(),
    data: z.object({ uuid: z.string() }).passthrough(),
  }).safeParse(payload);
  if (!body.success) return c.json({ error: 'Invalid event' }, 400);
  await withStore(storeId, tx => tx.insert(s.gatewayEvent).values({
    storeId, method: 'sezzle', accountId: account.accountId, mode: account.mode,
    eventId: body.data.uuid, eventType: body.data.event, providerRef: body.data.data.uuid,
    // Persist identity only; provider GET is authoritative for money and status.
    details: { receivedAt: new Date().toISOString() },
  }).onConflictDoNothing());
  return c.json({ received: true }, 200);
});
