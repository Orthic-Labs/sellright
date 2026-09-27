/**
 * Loyalty ledger — the ONLY writer of loyalty_ledger (migration 0070).
 *
 * Invariants:
 *  - Append-only. A balance is SUM(points) over the customer's rows, never a
 *    stored counter (a DB trigger rejects UPDATE).
 *  - Every balance-dependent posting runs under a per-customer transaction
 *    advisory lock (lockCustomerLoyalty), so two concurrent checkouts for the
 *    same customer serialize and the second sees the first's redemption —
 *    points cannot be double-spent.
 *  - System postings carry a deterministic source_ref (unique per store), so a
 *    replayed settle / refund / cancel / import is a no-op.
 *  - Reversals never drive a balance negative: the unpostable remainder is
 *    recorded as `shortfall` on the reversal row.
 *
 * Callers own the transaction (withStore → RLS scoped to the store).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import {
  loyaltySettingsFromConfig,
  proportionalTarget,
  unpostedExpiredPoints,
  type LoyaltySettings,
} from '../money/loyalty.js';

export type LoyaltyKind = s.LoyaltyLedgerKind;

/** Snapshot persisted on order.metadata.loyalty at checkout. */
export interface OrderLoyaltySnapshot {
  redeemPoints: number;
  pointsDiscount: number;
  earnPoints: number;
  expiryDays: number | null;
}

export function orderLoyaltySnapshot(metadata: unknown): OrderLoyaltySnapshot | null {
  const raw = (metadata as { loyalty?: Partial<OrderLoyaltySnapshot> } | null)?.loyalty;
  if (!raw || typeof raw !== 'object') return null;
  const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  return {
    redeemPoints: int(raw.redeemPoints), pointsDiscount: int(raw.pointsDiscount), earnPoints: int(raw.earnPoints),
    expiryDays: Number.isSafeInteger(raw.expiryDays) && (raw.expiryDays as number) > 0 ? raw.expiryDays as number : null,
  };
}

const DAY_MS = 86_400_000;
const expiryFrom = (at: Date, days: number | null) => (days ? new Date(at.getTime() + days * DAY_MS) : null);

/** Serialize every balance-dependent write for one customer (txn-scoped). */
export async function lockCustomerLoyalty(tx: Tx, storeId: string, customerId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'loyalty:' + storeId + ':' + customerId}, 0))`);
}

async function customerEntries(tx: Tx, customerId: string) {
  // Credits before debits on a timestamp tie: a debit can never precede the
  // credit it spends (balances never go negative), so this is the true order.
  return tx
    .select({ kind: s.loyaltyLedger.kind, points: s.loyaltyLedger.points, expiresAt: s.loyaltyLedger.expiresAt, createdAt: s.loyaltyLedger.createdAt })
    .from(s.loyaltyLedger)
    .where(eq(s.loyaltyLedger.customerId, customerId))
    .orderBy(asc(s.loyaltyLedger.createdAt), sql`(${s.loyaltyLedger.points} < 0)`, asc(s.loyaltyLedger.id));
}

export interface LoyaltyBalance {
  /** SUM of every ledger row. */
  balance: number;
  /** Points past their expiry that no `expire` row has written off yet. */
  pendingExpiry: number;
  /** What the customer can actually spend now: balance − pendingExpiry. */
  available: number;
}

export async function loyaltyBalance(tx: Tx, customerId: string, now = new Date()): Promise<LoyaltyBalance> {
  const entries = await customerEntries(tx, customerId);
  const balance = entries.reduce((n, e) => n + e.points, 0);
  const pendingExpiry = Math.min(Math.max(0, balance), unpostedExpiredPoints(entries, now));
  return { balance, pendingExpiry, available: Math.max(0, balance - pendingExpiry) };
}

/** Write off expired points with one `expire` row. Caller holds the lock. */
export async function postExpiry(tx: Tx, storeId: string, customerId: string, now = new Date()): Promise<number> {
  const { pendingExpiry } = await loyaltyBalance(tx, customerId, now);
  if (pendingExpiry <= 0) return 0;
  await tx.insert(s.loyaltyLedger).values({
    storeId, customerId, kind: 'expire', points: -pendingExpiry, createdAt: now,
    sourceRef: `expire:${customerId}:${now.getTime()}`, actor: 'system:loyalty-expiry', reason: 'points_expired',
  }).onConflictDoNothing();
  return pendingExpiry;
}

/** Lock + expire + read: the balance a redemption/adjustment may spend. */
export async function lockedAvailable(tx: Tx, storeId: string, customerId: string, now = new Date()): Promise<number> {
  await lockCustomerLoyalty(tx, storeId, customerId);
  await postExpiry(tx, storeId, customerId, now);
  return (await loyaltyBalance(tx, customerId, now)).available;
}

/** Reserve points for an order at creation (inside the checkout txn, after
 *  lockedAvailable). Idempotent per order. */
export async function reserveRedemption(tx: Tx, input: { storeId: string; customerId: string; orderId: string; points: number; discountCents: number }): Promise<void> {
  if (input.points <= 0) return;
  await tx.insert(s.loyaltyLedger).values({
    storeId: input.storeId, customerId: input.customerId, orderId: input.orderId, kind: 'redeem',
    points: -input.points, sourceRef: `redeem:${input.orderId}`, actor: 'system:checkout', reason: 'checkout_redemption',
    metadata: { discountCents: input.discountCents }, createdAt: new Date(),
  }).onConflictDoNothing();
}

/** Post the points an order earns. Called by every path that moves an order
 *  to Paid; idempotent per order (source_ref earn:<order>). Registered
 *  customers only — a guest order (no customer) earns nothing. */
export async function postEarnForPaidOrder(tx: Tx, storeId: string, orderId: string, paidAt = new Date()): Promise<number> {
  const [order] = await tx.select({ customerId: s.order.customerId, metadata: s.order.metadata })
    .from(s.order).where(eq(s.order.id, orderId)).limit(1);
  const snap = orderLoyaltySnapshot(order?.metadata);
  if (!order?.customerId || !snap || snap.earnPoints <= 0) return 0;
  await lockCustomerLoyalty(tx, storeId, order.customerId);
  const inserted = await tx.insert(s.loyaltyLedger).values({
    storeId, customerId: order.customerId, orderId, kind: 'earn', points: snap.earnPoints,
    expiresAt: expiryFrom(paidAt, snap.expiryDays), sourceRef: `earn:${orderId}`,
    actor: 'system:order-paid', reason: 'order_paid', createdAt: paidAt,
  }).onConflictDoNothing().returning({ id: s.loyaltyLedger.id });
  return inserted.length ? snap.earnPoints : 0;
}

/**
 * Converge an order's loyalty rows on the share of its money that has been
 * given back: restore redeemed points and reverse earned points in
 * proportion `num/den` (1/1 for a cancellation). Cumulative — each call
 * posts only the delta to the proportional target, keyed by `sourceRef`.
 * Restores post first so an earn reversal can draw on them; an earn
 * reversal larger than the spendable balance records the remainder as
 * `shortfall` instead of pushing the balance below zero.
 */
export async function reconcileOrderLoyalty(tx: Tx, input: {
  storeId: string; orderId: string; num: number; den: number; sourceRef: string; actor: string; refundId?: string | null;
  settings?: LoyaltySettings;
}): Promise<{ restored: number; reversed: number; shortfall: number }> {
  const none = { restored: 0, reversed: 0, shortfall: 0 };
  const rows = await tx.select().from(s.loyaltyLedger).where(eq(s.loyaltyLedger.orderId, input.orderId));
  if (!rows.length) return none;
  const customerId = rows[0]!.customerId;
  await lockCustomerLoyalty(tx, input.storeId, customerId);
  // Re-read under the lock: a concurrent reconcile for the same order may
  // have posted between the unlocked read and the lock grant.
  const locked = await tx.select().from(s.loyaltyLedger).where(eq(s.loyaltyLedger.orderId, input.orderId));
  const sum = (f: (r: typeof locked[number]) => number) => locked.reduce((n, r) => n + f(r), 0);
  const redeemed = sum((r) => (r.kind === 'redeem' ? -r.points : 0));
  const restored = sum((r) => (r.kind === 'reverse' && r.reason === 'redeem_restore' ? r.points : 0));
  const earned = sum((r) => (r.kind === 'earn' ? r.points : 0));
  const earnReversed = sum((r) => (r.kind === 'reverse' && r.reason === 'earn_reversal' ? -r.points + r.shortfall : 0));
  const now = new Date();
  const out = { ...none };

  const restoreDelta = proportionalTarget(redeemed, input.num, input.den) - restored;
  if (restoreDelta > 0) {
    let expiryDays = input.settings?.expiryDays ?? null;
    if (!input.settings) {
      const [st] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, input.storeId)).limit(1);
      expiryDays = loyaltySettingsFromConfig(st?.config).expiryDays;
    }
    const ins = await tx.insert(s.loyaltyLedger).values({
      storeId: input.storeId, customerId, orderId: input.orderId, refundId: input.refundId ?? null, kind: 'reverse',
      points: restoreDelta, expiresAt: expiryFrom(now, expiryDays), sourceRef: `${input.sourceRef}:restore`,
      actor: input.actor, reason: 'redeem_restore', createdAt: now,
    }).onConflictDoNothing().returning({ id: s.loyaltyLedger.id });
    if (ins.length) out.restored = restoreDelta;
  }

  const earnDelta = proportionalTarget(earned, input.num, input.den) - earnReversed;
  if (earnDelta > 0) {
    await postExpiry(tx, input.storeId, customerId, now);
    const { available } = await loyaltyBalance(tx, customerId, now);
    const posted = Math.min(earnDelta, Math.max(0, available));
    const shortfall = earnDelta - posted;
    const ins = await tx.insert(s.loyaltyLedger).values({
      storeId: input.storeId, customerId, orderId: input.orderId, refundId: input.refundId ?? null, kind: 'reverse',
      points: -posted, shortfall, sourceRef: `${input.sourceRef}:earn`, actor: input.actor, reason: 'earn_reversal',
      createdAt: new Date(now.getTime() + 1),
    }).onConflictDoNothing().returning({ id: s.loyaltyLedger.id });
    if (ins.length) { out.reversed = posted; out.shortfall = shortfall; }
  }
  return out;
}

/** Full release for an order that will never be paid / was cancelled. */
export async function releaseOrderLoyalty(tx: Tx, storeId: string, orderId: string, actor: string, settings?: LoyaltySettings) {
  return reconcileOrderLoyalty(tx, { storeId, orderId, num: 1, den: 1, sourceRef: `cancel:${orderId}`, actor, settings });
}

/** Loyalty effects of a SETTLED refund: proportional to money refunded over
 *  money captured for the order. Runs inside finalizeRefund's transaction. */
export async function reconcileRefundLoyalty(tx: Tx, input: { storeId: string; orderId: string; refundId: string; refunded: number; captured: number; actor: string }) {
  if (input.captured <= 0) return { restored: 0, reversed: 0, shortfall: 0 };
  return reconcileOrderLoyalty(tx, {
    storeId: input.storeId, orderId: input.orderId, num: input.refunded, den: input.captured,
    sourceRef: `refund:${input.refundId}`, refundId: input.refundId, actor: input.actor,
  });
}

export class LoyaltyAdjustError extends Error {}

/** Manual admin adjustment (caller enforces permission + writes audit_log).
 *  A debit larger than the spendable balance is refused. */
export async function adjustPoints(tx: Tx, input: {
  storeId: string; customerId: string; points: number; reason: string; actor: string; idempotencyKey?: string | null; expiryDays?: number | null;
}): Promise<{ id: string | null; balance: LoyaltyBalance }> {
  if (!Number.isSafeInteger(input.points) || input.points === 0) throw new LoyaltyAdjustError('points must be a non-zero integer');
  const now = new Date();
  const available = await lockedAvailable(tx, input.storeId, input.customerId, now);
  if (input.points < 0 && -input.points > available) throw new LoyaltyAdjustError(`cannot remove ${-input.points} points; ${available} available`);
  const [row] = await tx.insert(s.loyaltyLedger).values({
    storeId: input.storeId, customerId: input.customerId, kind: 'adjust', points: input.points,
    expiresAt: input.points > 0 ? expiryFrom(now, input.expiryDays ?? null) : null,
    sourceRef: input.idempotencyKey ? `adjust:${input.idempotencyKey}` : null,
    actor: input.actor, reason: input.reason, createdAt: now,
  }).onConflictDoNothing().returning({ id: s.loyaltyLedger.id });
  return { id: row?.id ?? null, balance: await loyaltyBalance(tx, input.customerId, now) };
}

export async function ledgerPage(tx: Tx, customerId: string, limit = 100) {
  return tx.select({
    id: s.loyaltyLedger.id, kind: s.loyaltyLedger.kind, points: s.loyaltyLedger.points, shortfall: s.loyaltyLedger.shortfall,
    reason: s.loyaltyLedger.reason, actor: s.loyaltyLedger.actor, expiresAt: s.loyaltyLedger.expiresAt,
    createdAt: s.loyaltyLedger.createdAt, orderCode: s.order.code,
  }).from(s.loyaltyLedger)
    .leftJoin(s.order, eq(s.order.id, s.loyaltyLedger.orderId))
    .where(and(eq(s.loyaltyLedger.customerId, customerId)))
    .orderBy(sql`${s.loyaltyLedger.createdAt} DESC`, sql`${s.loyaltyLedger.id} DESC`)
    .limit(limit);
}
