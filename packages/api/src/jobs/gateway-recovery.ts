/**
 * Gateway attempt recovery (payments audit D7/D8, D22 for Sezzle).
 *
 * NMI and Sezzle attempts that stay 'processing' (crash between insert and
 * finish), 'unknown' (lost/ambiguous response) or 'pending' (Sezzle session
 * the shopper never finished) hold the order: hasUnresolvedPayment blocks the
 * stale sweeper and a new payment attempt. Previously only an operator could
 * clear them. This job re-verifies each one through the SAME authoritative
 * read paths the shopper/admin verify routes use (verifyGatewayAttempt →
 * queryNmiPayment / Sezzle GET order → finishAttempt), and for Sezzle:
 *
 *  - approved but uncaptured: capture the full amount if the order is still
 *    payable for exactly this amount (legacy-store parity, spec item 45), otherwise
 *    release the authorization (Z12/D22) and record the attempt Declined.
 *  - never approved and older than the session expiry window: record it
 *    Declined ('session_expired') so the shopper can retry and the stale
 *    sweeper can release the stock. A late shopper completion still lands:
 *    the webhook re-verifies and settle.ts either pays the order or raises the
 *    MONEY-4 payment_after_cancel alert.
 *
 * Retries use exponential backoff kept in payment_attempt.context.recovery
 * (context is identity-only JSON; the extra key is ignored by environment
 * checks). After maxAttempts the attempt is flagged manual (stays in
 * /v1/admin/payment-reconciliation, unresolved) with an audit row.
 */
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { pool, withAdvisoryLock, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { finishAttempt, verifyGatewayAttempt } from '../payments/gateway-payment.js';
import { amountDueForOrder } from '../payments/settle.js';
import { resolveGatewayAccount, type GatewayAccount } from '../payments/gateway-account.js';
import { sezzleProvider, type SezzleOrder, type Money } from '../payments/sezzle.js';

type Attempt = typeof s.paymentAttempt.$inferSelect;
export interface RecoveryState { tries: number; nextAt?: string; lastError?: string; manual?: boolean }
export interface SezzleOps {
  getOrder(account: GatewayAccount, ref: string): Promise<SezzleOrder>;
  captureOrder(account: GatewayAccount, ref: string, money: Money, requestId: string): Promise<unknown>;
  releaseOrder(account: GatewayAccount, ref: string, money: Money, requestId: string): Promise<unknown>;
}
export interface RecoveryOptions {
  apply: boolean;
  /** Only attempts created at least this long ago are touched (minutes). */
  ageMin: number;
  /** Unapproved Sezzle checkout sessions older than this are expired (minutes). */
  sezzleSessionExpiryMin: number;
  maxAttempts: number;
  /** First backoff step (minutes); doubles per try, capped at 6h. */
  backoffBaseMin: number;
  now?: Date;
  log?: (m: string) => void;
  sezzle?: SezzleOps;
}

const MAX_BACKOFF_MS = 6 * 3_600_000;
export function recoveryBackoffMs(tries: number, baseMin: number): number {
  return Math.min(baseMin * 60_000 * 2 ** Math.max(0, tries - 1), MAX_BACKOFF_MS);
}
export function recoveryStateOf(attempt: Pick<Attempt, 'context'>): RecoveryState {
  const r = (attempt.context as { recovery?: RecoveryState } | null)?.recovery;
  return r && typeof r.tries === 'number' ? r : { tries: 0 };
}
export function recoveryDue(attempt: Pick<Attempt, 'context'>, now: Date): boolean {
  const r = recoveryStateOf(attempt);
  if (r.manual) return false;
  return !r.nextAt || Date.parse(r.nextAt) <= now.getTime();
}

export type SezzleDecision =
  | { kind: 'wait'; reason: string }
  | { kind: 'capture' }
  | { kind: 'release'; reason: string }
  | { kind: 'expire' };

/** Pure decision table for a still-unresolved Sezzle session (after verify). */
export function decideSezzleRecovery(input: {
  order: SezzleOrder; attemptReference: string; amount: number; currency: string;
  payable: boolean; ageMs: number; sessionExpiryMs: number;
}): SezzleDecision {
  const { order } = input;
  if (order.reference_id !== input.attemptReference ||
      order.order_amount?.amount_in_cents !== input.amount || order.order_amount?.currency !== input.currency) {
    return { kind: 'wait', reason: 'order_identity_or_amount_mismatch' };
  }
  if ((order.authorization?.captures ?? []).length || (order.authorization?.refunds ?? []).length ||
      (order.authorization?.releases ?? []).length || order.dispute?.id) {
    return { kind: 'wait', reason: 'provider_ledger_requires_reconciliation' };
  }
  if (order.authorization?.approved) {
    const expired = order.authorization.expiration && Date.parse(order.authorization.expiration) < Date.now();
    if (!expired && input.payable) return { kind: 'capture' };
    return { kind: 'release', reason: expired ? 'authorization_expired' : 'order_not_payable' };
  }
  if (input.ageMs >= input.sessionExpiryMs) return { kind: 'expire' };
  return { kind: 'wait', reason: 'session_open' };
}

async function orderContext(storeId: string, attempt: Attempt) {
  return withStore(storeId, async (tx) => {
    const [order] = await tx.select().from(s.order).where(eq(s.order.id, attempt.orderId)).limit(1);
    if (!order) return null;
    const due = await amountDueForOrder(tx, storeId, order.id, order.grandTotal);
    return { code: order.code, payable: order.state === 'PendingPayment' && due === attempt.amount };
  });
}

/** Returns true when the attempt left the unresolved set. */
async function recoverOne(storeId: string, attempt: Attempt, opts: RecoveryOptions, now: Date): Promise<{ resolved: boolean; note: string }> {
  if (attempt.method === 'nmi' || attempt.providerRef) {
    const first = await verifyGatewayAttempt(storeId, attempt.id);
    if (['settled', 'failed'].includes(first.status)) return { resolved: true, note: 'verified:' + first.status };
    if (attempt.method === 'nmi') return { resolved: false, note: 'nmi_unresolved' };
  }
  // Sezzle from here.
  if (!attempt.providerRef) return { resolved: false, note: 'sezzle_reference_missing' };
  const ops = opts.sezzle ?? sezzleProvider;
  const account = await resolveGatewayAccount(storeId, 'sezzle', attempt.accountId, attempt.mode as 'test' | 'live');
  const ctx = await orderContext(storeId, attempt);
  if (!ctx) return { resolved: false, note: 'order_missing' };
  const order = await ops.getOrder(account, attempt.providerRef);
  if (order.uuid !== attempt.providerRef) return { resolved: false, note: 'order_identity_mismatch' };
  const decision = decideSezzleRecovery({
    order, attemptReference: (attempt.context as { orderReference?: string } | null)?.orderReference ?? attempt.id,
    amount: attempt.amount, currency: attempt.currency, payable: ctx.payable,
    ageMs: now.getTime() - attempt.createdAt.getTime(), sessionExpiryMs: opts.sezzleSessionExpiryMin * 60_000,
  });
  if (decision.kind === 'wait') return { resolved: false, note: decision.reason };
  if (!opts.apply) return { resolved: false, note: 'dry-run:' + decision.kind };
  const money: Money = { amount_in_cents: attempt.amount, currency: attempt.currency };
  if (decision.kind === 'capture') {
    // Sezzle-Request-Id makes a retried capture idempotent at the provider.
    await ops.captureOrder(account, attempt.providerRef, money, attempt.id + ':capture');
    const after = await verifyGatewayAttempt(storeId, attempt.id);
    return { resolved: after.status === 'settled', note: 'captured:' + after.status };
  }
  const ref = attempt.providerRef;
  return withAdvisoryLock('pay:' + storeId + ':' + ctx.code, async () => {
    if (decision.kind === 'release') {
      await ops.releaseOrder(account, ref, money, attempt.id + ':release');
    }
    // Declined → attempt 'failed' + any Pending/Authorized payment row
    // downgraded (applyPaymentResult never downgrades Settled), which lifts
    // the hasUnresolvedPayment hold. finishAttempt is a no-op if a concurrent
    // webhook already settled the attempt.
    const reason = decision.kind === 'release' ? decision.reason : 'session_expired';
    const done = await finishAttempt(storeId, attempt.id, {
      state: 'Declined', providerRef: ref,
      errorMessage: decision.kind === 'release' ? 'Sezzle authorization released' : 'Sezzle checkout expired',
      metadata: { recovery: reason, released: decision.kind === 'release' },
    });
    await withStore(storeId, (tx) => tx.insert(s.auditLog).values({
      storeId, actor: 'system:gateway-recovery', entity: 'payment_attempt', entityId: attempt.id,
      action: decision.kind === 'release' ? 'sezzle_authorization_released' : 'sezzle_session_expired',
      data: { providerRef: ref, reason, status: done.status },
    }));
    return { resolved: done.status !== 'pending' && done.status !== 'unknown', note: decision.kind + ':' + done.status };
  });
}

export async function recoverGatewayAttempts(opts: RecoveryOptions): Promise<{ checked: number; resolved: number; manual: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.ageMin * 60_000);
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  const totals = { checked: 0, resolved: 0, manual: 0 };
  for (const store of stores.rows) {
    const rows = await withStore(store.id, (tx) => tx.select().from(s.paymentAttempt).where(and(
      inArray(s.paymentAttempt.method, ['nmi', 'sezzle']),
      inArray(s.paymentAttempt.operation, ['charge', 'session']),
      inArray(s.paymentAttempt.status, ['processing', 'unknown', 'pending']),
      lt(s.paymentAttempt.createdAt, cutoff),
      sql`coalesce((${s.paymentAttempt.context}->'recovery'->>'manual')::boolean, false) = false`,
    )).orderBy(asc(s.paymentAttempt.createdAt)).limit(50));
    for (const attempt of rows) {
      if (!recoveryDue(attempt, now)) continue;
      totals.checked++;
      let outcome: { resolved: boolean; note: string };
      try { outcome = await recoverOne(store.id, attempt, opts, now); }
      catch (e) { outcome = { resolved: false, note: 'error:' + (e instanceof Error ? e.message : 'unknown').slice(0, 120) }; }
      if (outcome.resolved) {
        totals.resolved++;
        opts.log?.(`[jobs:gateway-recovery] ${attempt.method} attempt ${attempt.id} resolved (${outcome.note})`);
        continue;
      }
      if (!opts.apply) {
        opts.log?.(`[jobs:gateway-recovery] dry-run ${attempt.method} attempt ${attempt.id}: ${outcome.note}`);
        continue;
      }
      const prev = recoveryStateOf(attempt);
      const tries = prev.tries + 1;
      const manual = tries >= opts.maxAttempts;
      const next: RecoveryState = {
        tries, lastError: outcome.note,
        ...(manual ? { manual: true } : { nextAt: new Date(now.getTime() + recoveryBackoffMs(tries, opts.backoffBaseMin)).toISOString() }),
      };
      await withStore(store.id, async (tx) => {
        // Only annotate while still unresolved — never touch a row a
        // concurrent verify/webhook just settled.
        const updated = await tx.update(s.paymentAttempt).set({
          context: sql`coalesce(${s.paymentAttempt.context}, '{}'::jsonb) || jsonb_build_object('recovery', ${JSON.stringify(next)}::jsonb)`,
        }).where(and(eq(s.paymentAttempt.id, attempt.id),
          inArray(s.paymentAttempt.status, ['processing', 'unknown', 'pending']))).returning({ id: s.paymentAttempt.id });
        if (manual && updated.length) {
          totals.manual++;
          await tx.insert(s.auditLog).values({
            storeId: store.id, actor: 'system:gateway-recovery', entity: 'payment_attempt', entityId: attempt.id,
            action: 'reconciliation_required',
            data: { method: attempt.method, orderId: attempt.orderId, tries, lastError: outcome.note },
          });
        }
      });
    }
  }
  return totals;
}
