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
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { customerOwnsOrder, orderProvenanceFilter } from '../auth/order-access.js';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import {
  earnableCents,
  loyaltySettingsFromConfig,
  multiplierBonusPoints,
  pointsEarned,
  proportionalTarget,
  unpostedExpiredPoints,
  type LoyaltySettings,
  type ProductMultiplier,
} from '../money/loyalty.js';

export type LoyaltyKind = s.LoyaltyLedgerKind;

/** Snapshot persisted on order.metadata.loyalty at checkout. */
export interface OrderLoyaltySnapshot {
  redeemPoints: number;
  pointsDiscount: number;
  earnPoints: number;
  expiryDays: number | null;
  /** Earn rate + product multipliers in force at checkout; lets an order edit
   *  recompute the earn on the order's OWN terms. Absent on older snapshots. */
  earnRatePerDollar?: number;
  productMultipliers?: ProductMultiplier[];
}

export function orderLoyaltySnapshot(metadata: unknown): OrderLoyaltySnapshot | null {
  const raw = (metadata as { loyalty?: Partial<OrderLoyaltySnapshot> } | null)?.loyalty;
  if (!raw || typeof raw !== 'object') return null;
  const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  return {
    redeemPoints: int(raw.redeemPoints), pointsDiscount: int(raw.pointsDiscount), earnPoints: int(raw.earnPoints),
    expiryDays: Number.isSafeInteger(raw.expiryDays) && (raw.expiryDays as number) > 0 ? raw.expiryDays as number : null,
    ...(Number.isSafeInteger(raw.earnRatePerDollar) && (raw.earnRatePerDollar as number) > 0 ? { earnRatePerDollar: raw.earnRatePerDollar as number } : {}),
    ...(Array.isArray(raw.productMultipliers) ? { productMultipliers: (raw.productMultipliers as ProductMultiplier[]).filter((m) => m && typeof m.productId === 'string' && Number(m.multiplier) > 1) } : {}),
  };
}

const DAY_MS = 86_400_000;
const expiryFrom = (at: Date, days: number | null) => (days ? new Date(at.getTime() + days * DAY_MS) : null);

/** Serialize every balance-dependent write for one customer (txn-scoped). */
export async function lockCustomerLoyalty(tx: Tx, storeId: string, customerId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'loyalty:' + storeId + ':' + customerId}, 0))`);
}

async function customerEntries(tx: Tx, customerId: string) {
  const [customer] = await tx.select({ email: s.customer.email, emailVerified: s.customer.emailVerified }).from(s.customer).where(eq(s.customer.id, customerId)).limit(1);
  if (!customer) return [];
  // Credits before debits on a timestamp tie: a debit can never precede the
  // credit it spends (balances never go negative), so this is the true order.
  return tx
    .select({ kind: s.loyaltyLedger.kind, points: s.loyaltyLedger.points, expiresAt: s.loyaltyLedger.expiresAt, createdAt: s.loyaltyLedger.createdAt })
    .from(s.loyaltyLedger)
    .leftJoin(s.order, eq(s.order.id, s.loyaltyLedger.orderId))
    .where(and(eq(s.loyaltyLedger.customerId, customerId), or(isNull(s.loyaltyLedger.orderId), and(eq(s.order.customerId, customerId), orderProvenanceFilter(customer)))))
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
  // Edit earn that was held back while an order balance was unpaid becomes
  // spendable only once that balance is settled; materialize it here so a
  // spend/adjust always sees it (idempotent per order_edit id).
  await settleDeferredEditEarns(tx, storeId, customerId, now);
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
  const [customer] = await tx.select({ id: s.customer.id, email: s.customer.email, emailVerified: s.customer.emailVerified }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1);
  if (!customerOwnsOrder(customer, order)) return 0;
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
  // Earned base = the original earn row plus every order-edit earn adjustment
  // (intended points: posted + shortfall), so a refund after an edit reverses
  // what the edited order actually earned, never the pre-edit figure.
  const earned = Math.max(0, sum((r) => (r.kind === 'earn' ? r.points
    : r.kind === 'adjust' && r.reason === 'order_edit_earn' ? r.points - r.shortfall : 0)));
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

/**
 * Points an edited order should have earned, on the order's own earn terms
 * (snapshot rate + multipliers). Null when it cannot be computed exactly: a
 * snapshot taken before the rate was recorded has no rate to apply.
 */
export function editedEarnTarget(snap: OrderLoyaltySnapshot, input: {
  subtotal: number; discountTotal: number; taxRate: number; taxInclusive: boolean; lines: Array<{ productId: string; cents: number }>;
}): number | null {
  if (!snap.earnRatePerDollar) return null;
  const base = earnableCents(input);
  return pointsEarned(base, snap.earnRatePerDollar) + multiplierBonusPoints({
    lines: input.lines, subtotal: input.subtotal, earnableCents: base,
    earnRatePerDollar: snap.earnRatePerDollar, multipliers: snap.productMultipliers ?? [],
  });
}

/**
 * Order edit changed a PAID order's merchandise: post the earn delta as an
 * `adjust` row (reason order_edit_earn), idempotent per order_edit id
 * (source_ref order_edit:<id>:earn). The tracked earn is the original `earn`
 * row plus every prior edit adjustment (points - shortfall). A reduction larger
 * than the spendable balance posts only what is available and records the rest
 * as `shortfall` — the balance never goes negative. No-op when the order never
 * earned (guest, program off, unpaid at the time) or the snapshot has no rate.
 */
export async function postEditEarnAdjustment(tx: Tx, input: {
  storeId: string; orderId: string; editId: string; targetEarn: number; actor: string;
}): Promise<{ delta: number; posted: number; shortfall: number }> {
  const none = { delta: 0, posted: 0, shortfall: 0 };
  const [order] = await tx.select({ customerId: s.order.customerId, metadata: s.order.metadata }).from(s.order).where(eq(s.order.id, input.orderId)).limit(1);
  if (!order?.customerId) return none;
  const snap = orderLoyaltySnapshot(order.metadata);
  await lockCustomerLoyalty(tx, input.storeId, order.customerId);
  const rows = await tx.select().from(s.loyaltyLedger).where(eq(s.loyaltyLedger.orderId, input.orderId));
  if (!rows.some((r) => r.kind === 'earn')) return none;
  const tracked = rows.reduce((n, r) => n + (r.kind === 'earn' ? r.points : r.kind === 'adjust' && r.reason === 'order_edit_earn' ? r.points - r.shortfall : 0), 0);
  const delta = Math.max(0, input.targetEarn) - tracked;
  if (delta === 0) return none;
  const now = new Date();
  if (delta > 0) {
    const ins = await tx.insert(s.loyaltyLedger).values({
      storeId: input.storeId, customerId: order.customerId, orderId: input.orderId, kind: 'adjust', points: delta,
      expiresAt: snap?.expiryDays ? new Date(now.getTime() + snap.expiryDays * DAY_MS) : null,
      sourceRef: `order_edit:${input.editId}:earn`, actor: input.actor, reason: 'order_edit_earn', createdAt: now,
    }).onConflictDoNothing().returning({ id: s.loyaltyLedger.id });
    return ins.length ? { delta, posted: delta, shortfall: 0 } : none;
  }
  await postExpiry(tx, input.storeId, order.customerId, now);
  const { available } = await loyaltyBalance(tx, order.customerId, now);
  const posted = Math.min(-delta, Math.max(0, available));
  const shortfall = -delta - posted;
  const ins = await tx.insert(s.loyaltyLedger).values({
    storeId: input.storeId, customerId: order.customerId, orderId: input.orderId, kind: 'adjust', points: -posted, shortfall,
    sourceRef: `order_edit:${input.editId}:earn`, actor: input.actor, reason: 'order_edit_earn', createdAt: now,
  }).onConflictDoNothing().returning({ id: s.loyaltyLedger.id });
  return ins.length ? { delta, posted: -posted, shortfall } : none;
}

/** Merge a patch into order.metadata.loyalty (null removes the key). */
async function patchOrderLoyaltyMeta(tx: Tx, storeId: string, orderId: string, patch: Record<string, unknown>): Promise<void> {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      await tx.execute(sql`UPDATE "order" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{loyalty}', (coalesce(metadata->'loyalty', '{}'::jsonb) - ${k}::text), true) WHERE id = ${orderId} AND store_id = ${storeId} AND metadata ? 'loyalty'`);
    } else {
      await tx.execute(sql`UPDATE "order" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{loyalty}', coalesce(metadata->'loyalty', '{}'::jsonb) || jsonb_build_object(${k}::text, ${JSON.stringify(v)}::jsonb), true) WHERE id = ${orderId} AND store_id = ${storeId} AND metadata ? 'loyalty'`);
    }
  }
}

export interface EditEarnResult { delta: number; posted: number; shortfall: number; deferred?: boolean; snapshotUpdated?: boolean }

/**
 * Order edit moved an order's merchandise: bring its earn in line with
 * `targetEarn`.
 *  - UNPAID order (PendingPayment, no earn row yet): rewrite the checkout
 *    snapshot's earnPoints so the eventual payment earns on the EDITED
 *    merchandise (postEarnForPaidOrder reads the snapshot).
 *  - Paid order that already earned: post the delta (postEditEarnAdjustment).
 *    A POSITIVE delta while the balance is still unpaid (`settled` false) is
 *    not posted: it is parked on order.metadata.loyalty.deferredEarn and
 *    posted by settleDeferredEditEarnForOrder once the balance clears.
 *    Reductions always post immediately.
 */
export async function syncEditEarn(tx: Tx, input: {
  storeId: string; orderId: string; editId: string; targetEarn: number; actor: string; settled: boolean;
}): Promise<EditEarnResult> {
  const none: EditEarnResult = { delta: 0, posted: 0, shortfall: 0 };
  const [order] = await tx.select({ customerId: s.order.customerId, metadata: s.order.metadata, state: s.order.state })
    .from(s.order).where(and(eq(s.order.id, input.orderId), eq(s.order.storeId, input.storeId))).limit(1);
  if (!order?.customerId) return none;
  const snap = orderLoyaltySnapshot(order.metadata);
  if (!snap) return none;
  await lockCustomerLoyalty(tx, input.storeId, order.customerId);
  const rows = await tx.select().from(s.loyaltyLedger).where(eq(s.loyaltyLedger.orderId, input.orderId));
  const target = Math.max(0, input.targetEarn);
  if (!rows.some((r) => r.kind === 'earn')) {
    if (order.state !== 'PendingPayment' || snap.earnPoints === target) return none;
    await patchOrderLoyaltyMeta(tx, input.storeId, input.orderId, { earnPoints: target });
    return { delta: target - snap.earnPoints, posted: 0, shortfall: 0, snapshotUpdated: true };
  }
  const tracked = rows.reduce((n, r) => n + (r.kind === 'earn' ? r.points : r.kind === 'adjust' && r.reason === 'order_edit_earn' ? r.points - r.shortfall : 0), 0);
  const delta = target - tracked;
  const hadDeferred = !!(order.metadata as { loyalty?: { deferredEarn?: unknown } } | null)?.loyalty?.deferredEarn;
  if (delta > 0 && !input.settled) {
    await patchOrderLoyaltyMeta(tx, input.storeId, input.orderId, { deferredEarn: { editId: input.editId, targetEarn: target } });
    return { delta, posted: 0, shortfall: 0, deferred: true };
  }
  if (hadDeferred) await patchOrderLoyaltyMeta(tx, input.storeId, input.orderId, { deferredEarn: null });
  return postEditEarnAdjustment(tx, { storeId: input.storeId, orderId: input.orderId, editId: input.editId, targetEarn: target, actor: input.actor });
}

/** Post a held-back edit earn for ONE order if its balance is now settled.
 *  Idempotent (ledger source_ref per edit id; the marker is cleared after). */
export async function settleDeferredEditEarnForOrder(tx: Tx, storeId: string, orderId: string): Promise<number> {
  const [order] = await tx.select({ customerId: s.order.customerId, metadata: s.order.metadata, state: s.order.state, grandTotal: s.order.grandTotal })
    .from(s.order).where(and(eq(s.order.id, orderId), eq(s.order.storeId, storeId))).limit(1);
  const deferred = (order?.metadata as { loyalty?: { deferredEarn?: { editId?: string; targetEarn?: number } } } | null)?.loyalty?.deferredEarn;
  if (!order?.customerId || !deferred?.editId || !Number.isSafeInteger(deferred.targetEarn)) return 0;
  if (order.state !== 'Paid' && order.state !== 'PartiallyRefunded') return 0;
  const { amountDueForOrder } = await import('../payments/settle.js'); // lazy: settle → bonus → ledger
  if ((await amountDueForOrder(tx, storeId, orderId, order.grandTotal)) > 0) return 0;
  await lockCustomerLoyalty(tx, storeId, order.customerId);
  const r = await postEditEarnAdjustment(tx, { storeId, orderId, editId: deferred.editId, targetEarn: deferred.targetEarn!, actor: 'system:order-edit-settled' });
  await patchOrderLoyaltyMeta(tx, storeId, orderId, { deferredEarn: null });
  return r.posted;
}

export async function settleDeferredEditEarns(tx: Tx, storeId: string, customerId: string, _now = new Date()): Promise<void> {
  const rows = await tx.select({ id: s.order.id }).from(s.order).where(and(
    eq(s.order.storeId, storeId), eq(s.order.customerId, customerId), sql`${s.order.metadata}->'loyalty'->'deferredEarn' is not null`,
  ));
  for (const r of rows) await settleDeferredEditEarnForOrder(tx, storeId, r.id);
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

export async function ledgerPage(tx: Tx, customerId: string, limit = 100, customer?: { email: string; emailVerified: boolean }) {
  return tx.select({
    id: s.loyaltyLedger.id, kind: s.loyaltyLedger.kind, points: s.loyaltyLedger.points, shortfall: s.loyaltyLedger.shortfall,
    reason: s.loyaltyLedger.reason, actor: s.loyaltyLedger.actor, expiresAt: s.loyaltyLedger.expiresAt,
    createdAt: s.loyaltyLedger.createdAt, orderCode: s.order.code, metadata: s.loyaltyLedger.metadata,
  }).from(s.loyaltyLedger)
    .leftJoin(s.order, eq(s.order.id, s.loyaltyLedger.orderId))
    .where(and(eq(s.loyaltyLedger.customerId, customerId), customer ? or(isNull(s.loyaltyLedger.orderId), and(eq(s.order.customerId, customerId), orderProvenanceFilter(customer))) : undefined))
    .orderBy(sql`${s.loyaltyLedger.createdAt} DESC`, sql`${s.loyaltyLedger.id} DESC`)
    .limit(limit);
}
