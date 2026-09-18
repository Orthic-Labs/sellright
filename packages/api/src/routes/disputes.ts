/**
 * PAR-07: dispute/chargeback ingestion + operator surface.
 *
 *   POST /v1/webhooks/nmi/{storeId}/{accountId} — NMI `chargeback.batch.complete`
 *        push. Signature `webhook-signature: t=<unix>,s=<hex>` = HMAC-SHA256 of
 *        `t.rawBody` with the account's `privateKey` (the gateway-account
 *        signing-secret field — same field Sezzle uses for its HMAC). The
 *        signature selects the account; request parameters never do.
 *   GET  /v1/admin/disputes                     — operator list (per store).
 *
 * Mounted outside the shop/admin CSRF guards (same as /v1/webhooks/stripe and
 * /v1/webhooks/sezzle): the provider signature is the authentication.
 *
 * Deliberate non-parity with DD: the DD handler auto-cancelled unfulfilled
 * orders on chargeback. SellRight's stance (webhook-reconcile.ts) is that
 * disputes need human handling — we record + alert, never auto-cancel.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { and, desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { dispute } from '../db/schema-ops.js';
import { gatewayAccount } from '../payments/gateway-account.js';
import { recordDispute } from '../disputes/disputes.js';
import { J, errBody, guard, requireAdmin, requireStore } from './admin-helpers.js';
import { err as logErr } from '../lib/logger.js';

export const disputeRoutes = new OpenAPIHono();
disputeRoutes.use('/v1/webhooks/nmi/*', bodyLimit({ maxSize: 262144 }));

/** NMI signature format: `t=<unix-seconds>,s=<hex-hmac>` over `t.rawBody`. */
export function verifyNmiSignature(rawBody: string, signature: string | undefined, signingKey: string): boolean {
  if (!signingKey || !signature) return false;
  const m = /^t=([^,]+),s=([a-f0-9]+)$/i.exec(signature);
  if (!m) return false;
  const expected = createHmac('sha256', signingKey).update(`${m[1]}.${rawBody}`).digest('hex');
  const received = m[2]!.toLowerCase();
  return expected.length === received.length && timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

/** NMI reports amounts as decimal dollar strings ("12.34"). */
export function nmiAmountToCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const NmiEvent = z.object({
  event_id: z.string().max(200).optional(),
  event_type: z.string().max(120).optional(),
  event_body: z.object({
    chargebacks: z.array(z.object({
      id: z.union([z.string(), z.number()]).optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      reason: z.string().max(500).optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough();

disputeRoutes.post('/v1/webhooks/nmi/:storeId/:accountId', async (c) => {
  const storeId = c.req.param('storeId');
  if (!z.string().uuid().safeParse(storeId).success) return c.json({ error: 'unknown account' }, 404);
  let account;
  try {
    account = gatewayAccount(storeId, 'nmi', c.req.param('accountId'));
  } catch {
    return c.json({ error: 'unknown account' }, 404);
  }
  const raw = await c.req.text();
  if (!verifyNmiSignature(raw, c.req.header('webhook-signature'), account.privateKey ?? '')) {
    return c.json({ error: 'invalid signature' }, 401);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return c.json({ error: 'invalid event' }, 400); }
  const body = NmiEvent.safeParse(parsed);
  if (!body.success) return c.json({ error: 'invalid event' }, 400);
  if (body.data.event_type !== 'chargeback.batch.complete') return c.json({ received: true }, 200);

  const chargebacks = body.data.event_body?.chargebacks ?? [];
  const result = await withStore(storeId, async (tx) => {
    // Idempotency at the EVENT level too: a replayed batch event acks without
    // re-scanning. Dispute-level dedupe in recordDispute covers per-chargeback
    // retries even when event ids differ.
    const eventId = body.data.event_id ? `nmi:${storeId}:${body.data.event_id}` : null;
    if (eventId) {
      const claimed = await tx.insert(s.processedEvent)
        .values({ id: eventId, storeId, type: body.data.event_type! })
        .onConflictDoNothing().returning({ id: s.processedEvent.id });
      if (!claimed.length) return { duplicates: true as const };
    }
    let recorded = 0;
    let skipped = 0;
    for (const cb of chargebacks) {
      const transactionId = String(cb.id ?? '').trim();
      if (!transactionId) { skipped++; continue; }
      // The chargeback id IS the original gateway transaction id (DD parity) —
      // link it back to our payment/order ledger row.
      const [pay] = await tx.select({ id: s.payment.id, orderId: s.payment.orderId })
        .from(s.payment)
        .where(and(eq(s.payment.providerRef, transactionId), eq(s.payment.method, 'nmi')))
        .limit(1);
      let orderCode: string | null = null;
      if (pay?.orderId) {
        const [o] = await tx.select({ code: s.order.code }).from(s.order).where(eq(s.order.id, pay.orderId)).limit(1);
        orderCode = o?.code ?? null;
      }
      const res = await recordDispute(tx, storeId, {
        provider: 'nmi',
        providerRef: transactionId,
        paymentId: pay?.id ?? null,
        orderId: pay?.orderId ?? null,
        orderCode,
        amountCents: nmiAmountToCents(cb.amount),
        reason: cb.reason ?? null,
        status: 'open',
        details: { eventId: body.data.event_id ?? null },
        actor: 'nmi:webhook',
      });
      if (res.created) recorded++;
      else skipped++;
      if (!pay) {
        logErr.error('nmi chargeback for unknown transaction', undefined, { storeId, transactionId });
      }
    }
    return { recorded, skipped };
  });
  if ('duplicates' in result) return c.json({ received: true }, 200);
  return c.json({ received: true, ...result }, 200);
});

// ── admin: dispute list (operator visibility for BOTH providers) ─────────────
disputeRoutes.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/disputes', summary: 'List recorded disputes/chargebacks',
    request: { query: z.object({ provider: z.enum(['stripe', 'nmi']).optional() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { provider } = c.req.valid('query');
    const items = await withStore(st.storeId, async (tx) => {
      const rows = await tx.select({
        id: dispute.id, provider: dispute.provider, providerRef: dispute.providerRef,
        orderId: dispute.orderId, amount: dispute.amount, currency: dispute.currency,
        reason: dispute.reason, status: dispute.status, notifiedAt: dispute.notifiedAt,
        createdAt: dispute.createdAt, orderCode: s.order.code,
      }).from(dispute)
        .leftJoin(s.order, eq(s.order.id, dispute.orderId))
        .where(provider ? eq(dispute.provider, provider) : undefined)
        .orderBy(desc(dispute.createdAt)).limit(200);
      return rows.map((r) => ({ ...r, notifiedAt: r.notifiedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
    });
    return c.json({ items }, 200);
  }),
);
