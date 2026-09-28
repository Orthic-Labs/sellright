import { createHash } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { customerToken } from '../auth/session.js';
import { clientIp, attemptRetryAfter } from '../auth/rate-limit.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveStoreFromCtx } from './store-context.js';
import { resolveGatewayAccount } from '../payments/gateway-account.js';
import { normalizeSezzleEvent, verifySezzleSignature } from '../payments/sezzle.js';
import { recordDispute } from '../disputes/disputes.js';
import {
  GatewayPaymentError, startGatewayPayment, readGatewayAttempt, verifyGatewayAttempt,
} from '../payments/gateway-payment.js';
import { apiErrorSchema, errJson, slugifyCode } from '../lib/api-error.js';
import type { Context } from 'hono';

export const gatewayPayments = new OpenAPIHono();
gatewayPayments.use('/v1/webhooks/sezzle/*', bodyLimit({ maxSize: 262144 }));
const requestSchema = z.object({
  method: z.enum(['nmi', 'sezzle']),
  token: z.string().min(1).max(4096).optional(),
}).strict();

// Shared response shape for both routes below — mirrors `view()` in
// ../payments/gateway-payment.ts: the persisted attempt row plus whatever the
// provider-specific `result` JSON carries (Sezzle's checkoutUrl/state; NMI
// carries neither). Documented here (SR-storefront-client audit) so the
// generated OpenAPI contract — and the typed storefront client built from it
// — actually cover the checkout payment path; these two routes used to be
// plain, undocumented Hono handlers.
const gatewayAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  status: z.string(),
  checkoutUrl: z.string().optional(),
  state: z.string().optional(),
}).openapi('GatewayAttempt');

// The verify/reconcile route's result is genuinely heterogeneous — it fans
// out to a charge view (attemptId/status/checkoutUrl/state, same as above), a
// Sezzle-session view, or a refund reconciliation view (attemptId/status plus
// finalizeRefund's own fields — refundId/refundState/etc., see
// ../payments/gateway-payment.ts's reconcileRefundAttempt). Rather than
// hand-fork three near-duplicate schemas that will drift from the real
// branches, this documents the two fields every branch guarantees and passes
// the rest through — a typed client still gets `attemptId`/`status` typed,
// plus whatever else came back as an open record.
const gatewayVerifyResultSchema = z.object({
  attemptId: z.string().uuid(),
  status: z.string(),
  checkoutUrl: z.string().optional(),
  state: z.string().optional(),
  refundId: z.string().optional(),
  refundState: z.string().optional(),
}).openapi('GatewayVerifyResult');

const errorSchema = apiErrorSchema();

/** GatewayPaymentError.status is a genuine union (400|404|409|503), not a
 *  literal, at either catch site below. Passing it straight to `errJson`
 *  collapses Hono's per-status response typing into one non-distributed
 *  union that fails to match a route's discriminated `responses` map — this
 *  switch forces a real status LITERAL at each call, which Hono distributes
 *  correctly. */
function gatewayErrorResponse(c: Context, error: GatewayPaymentError) {
  const code = slugifyCode(error.message);
  switch (error.status) {
    case 400: return errJson(c, 400, code, error.message);
    case 404: return errJson(c, 404, code, error.message);
    case 409: return errJson(c, 409, code, error.message);
    case 503: return errJson(c, 503, code, error.message);
  }
}


gatewayPayments.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/orders/{code}/gateway-payment',
    summary: 'Start a gateway payment attempt (NMI charge or Sezzle hosted session)',
    request: {
      params: z.object({ code: z.string() }),
      headers: z.object({
        'idempotency-key': z.string().min(1).max(200),
        'x-receipt-token': z.string().optional(),
      }),
      body: { content: { 'application/json': { schema: requestSchema } } },
    },
    responses: {
      200: { description: 'Attempt started', content: { 'application/json': { schema: gatewayAttemptSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      404: { description: 'Order not found', content: { 'application/json': { schema: errorSchema } } },
      409: { description: 'Payment method disabled', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Gateway unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const retry = await attemptRetryAfter(clientIp(c), 'gateway:' + clientIp(c));
    if (retry) return errJson(c, 429, 'RATE_LIMITED', 'Too many payment attempts');
    const key = c.req.header('idempotency-key');
    if (!key || key.length > 200) {
      return errJson(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key required (maximum 200 characters)', { param: 'idempotency-key' });
    }
    const body = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return errJson(c, 400, 'INVALID_PAYMENT_REQUEST', 'Invalid payment request');
    try {
      const result = await startGatewayPayment({
        storeId: st.id, code: c.req.param('code'), config: st.config,
        ...body.data, idempotencyKey: key, receiptToken: c.req.header('x-receipt-token'),
        customerSession: customerToken(c),
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof GatewayPaymentError) return gatewayErrorResponse(c, error);
      throw error;
    }
  },
);

gatewayPayments.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/orders/{code}/gateway-payment/{attempt}/verify',
    summary: 'Reconcile a gateway payment attempt with the provider',
    request: {
      params: z.object({ code: z.string(), attempt: z.string() }),
      headers: z.object({ 'x-receipt-token': z.string().optional() }),
    },
    responses: {
      200: { description: 'Attempt reconciled', content: { 'application/json': { schema: gatewayVerifyResultSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      404: { description: 'Payment or order not found', content: { 'application/json': { schema: errorSchema } } },
      409: { description: 'Requires separate reconciliation / environment mismatch', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Gateway unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const retry = await attemptRetryAfter(clientIp(c), 'gateway-verify:' + clientIp(c));
    if (retry) return errJson(c, 429, 'RATE_LIMITED', 'Too many verification attempts');
    try {
      const input = { storeId: st.id, code: c.req.param('code'), id: c.req.param('attempt'),
        receiptToken: c.req.header('x-receipt-token'), customerSession: customerToken(c) };
      if (!z.string().uuid().safeParse(input.id).success) return errJson(c, 404, 'PAYMENT_NOT_FOUND', 'Payment not found');
      await readGatewayAttempt(input);
      return c.json(await verifyGatewayAttempt(st.id, input.id), 200);
    } catch (error) {
      if (error instanceof GatewayPaymentError) return gatewayErrorResponse(c, error);
      throw error;
    }
  },
);

// Signature selects the configured account. Request headers never select another tenant.
gatewayPayments.post('/v1/webhooks/sezzle/:storeId/:accountId', async c => {
  const storeId = c.req.param('storeId');
  if (!z.string().uuid().safeParse(storeId).success) return c.json({ error: 'Unknown account' }, 404);
  let account;
  try { account = await resolveGatewayAccount(storeId, 'sezzle', c.req.param('accountId')); }
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
