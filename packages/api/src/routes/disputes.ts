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
 * DD parity (#395): like the DD handler, an NMI chargeback auto-cancels an
 * UNFULFILLED order without a refund and notes the order; a fulfilled order is
 * left alone and noted for review (disputes/nmi-chargeback.ts). Stripe disputes
 * stay record + alert + entitlement reversal (webhook-reconcile.ts).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { and, desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { dispute } from '../db/schema-ops.js';
import { resolveGatewayAccount, type GatewayAccount } from '../payments/gateway-account.js';
import { recordDispute } from '../disputes/disputes.js';
import { applyNmiChargebackToOrder } from '../disputes/nmi-chargeback.js';
import { onStockChanged } from '../manifest/stock-hook.js';
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
  const accountId = c.req.param('accountId');
  // Every named or DB-backed account can have distinct mode credentials.
  // Exactly one authenticated identity must own this callback.
  const candidates: GatewayAccount[] = [];
  for (const mode of ['live', 'test'] as const) {
    try { candidates.push(await resolveGatewayAccount(storeId, 'nmi', accountId, mode)); } catch { /* not configured */ }
  }
  if (!candidates.length) return c.json({ error: 'invalid signature' }, 401);
  const raw = await c.req.text();
  const verified = candidates.filter((a) => verifyNmiSignature(raw, c.req.header('webhook-signature'), a.privateKey ?? ''));
  if (verified.length !== 1) {
    return c.json({ error: 'invalid signature' }, 401);
  }
  const account = verified[0]!;
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
    const eventId = body.data.event_id ? `nmi:v2:${createHash('sha256').update(JSON.stringify(
      ['nmi-event-v2', storeId, account.accountId, account.mode, body.data.event_id],
    )).digest('hex')}` : null;
    if (eventId) {
      const claimed = await tx.insert(s.processedEvent)
        .values({ id: eventId, storeId, type: body.data.event_type! })
        .onConflictDoNothing().returning({ id: s.processedEvent.id });
      if (!claimed.length) return { duplicates: true as const };
    }
    let recorded = 0;
    let skipped = 0;
    let stockChanged = false;
    for (const cb of chargebacks) {
      const transactionId = String(cb.id ?? '').trim();
      if (!transactionId) { skipped++; continue; }
      // The chargeback id IS the original gateway transaction id (DD parity) —
      // link it back to our payment/order ledger row.
      const payments = await tx.select({ id: s.payment.id, orderId: s.payment.orderId })
        .from(s.payment)
        // Transaction ids can collide across NMI accounts/modes — bind the
        // ledger lookup to the account+mode whose key signed this event.
        // NULL historical identity is unresolved, never evidence that the
        // callback's authenticated account/mode owns this payment.
        .where(and(eq(s.payment.storeId, storeId), eq(s.payment.providerRef, transactionId),
          eq(s.payment.method, 'nmi'), eq(s.payment.gatewayAccount, account.accountId),
          eq(s.payment.gatewayMode, account.mode)))
        .limit(2);
      const pay = payments.length === 1 ? payments[0] : undefined;
      let orderCode: string | null = null;
      if (pay?.orderId) {
        const [o] = await tx.select({ code: s.order.code }).from(s.order)
          .where(and(eq(s.order.storeId, storeId), eq(s.order.id, pay.orderId))).limit(1);
        orderCode = o?.code ?? null;
      }
      const res = await recordDispute(tx, storeId, {
        provider: 'nmi',
        providerRef: transactionId,
        gatewayAccount: account.accountId,
        gatewayMode: account.mode,
        paymentId: pay?.id ?? null,
        orderId: pay?.orderId ?? null,
        orderCode,
        amountCents: nmiAmountToCents(cb.amount),
        reason: cb.reason ?? null,
        status: 'open',
        details: { eventId: body.data.event_id ?? null },
        actor: 'nmi:webhook',
      });
      if (res.created) {
        recorded++;
        // DD parity: cancel an unfulfilled order (no refund), note a fulfilled one, reverse entitlements.
        if (res.orderId && res.disputeId) {
          const applied = await applyNmiChargebackToOrder(tx, storeId, {
            orderId: res.orderId, disputeRecordId: res.disputeId, transactionId, reason: cb.reason ?? null });
          if (applied.stockChanged) stockChanged = true;
          if (applied.outcome === 'not_cancelled_fulfilled') {
            logErr.error('nmi chargeback on a fulfilled order — review immediately', undefined, { storeId, transactionId, orderCode });
          }
        }
      } else skipped++;
      if (!pay) {
        logErr.error('nmi chargeback for unknown transaction', undefined, { storeId, transactionId, gatewayAccount: account.accountId, gatewayMode: account.mode });
      }
    }
    return { recorded, skipped, stockChanged };
  });
  if ('duplicates' in result) return c.json({ received: true }, 200);
  if (result.stockChanged) {
    const [store] = await withStore(storeId, (tx) => tx.select({ slug: s.store.slug }).from(s.store).where(eq(s.store.id, storeId)).limit(1));
    if (store) onStockChanged(store.slug);
  }
  return c.json({ received: true, recorded: result.recorded, skipped: result.skipped }, 200);
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
        gatewayAccount: dispute.gatewayAccount, gatewayMode: dispute.gatewayMode,
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
