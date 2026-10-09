/**
 * Bonus earn rules on the loyalty ledger (REWARDS-1). Every grant is one
 * `bonus` row with a deterministic source_ref, so a trigger fires at most
 * once no matter how often the code path replays:
 *
 *   review      bonus:review:<reviewId>
 *   signup      bonus:signup:<customerId>
 *   first_order bonus:first_order:<customerId>
 *   birthday    bonus:birthday:<customerId>:<year>
 *
 * Admin reversal is an ordinary `reverse` row (bonus_reverse:<ledgerId>); the
 * original source_ref stays, so a reversed bonus can never be re-granted by
 * replaying its trigger. Amounts, on/off and eligibility all come from
 * store.config.loyalty — nothing is hard-coded. Callers own the transaction.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { customerOwnsOrder } from '../auth/order-access.js';
import { loyaltySettingsFromConfig, type LoyaltySettings } from '../money/loyalty.js';
import { enqueuePointsEarned } from '../email/dispatch.js';
import { loyaltyBalance, lockCustomerLoyalty, postEarnForPaidOrder, postExpiry } from './ledger.js';

export type BonusRule = 'review' | 'signup' | 'first_order' | 'birthday';

export const BONUS_LABELS: Record<BonusRule, string> = {
  review: 'Review bonus',
  signup: 'Welcome bonus',
  first_order: 'First order bonus',
  birthday: 'Birthday bonus',
};

const DAY_MS = 86_400_000;
const expiryFrom = (at: Date, days: number | null) => (days ? new Date(at.getTime() + days * DAY_MS) : null);

async function storeProgram(tx: Tx, storeId: string): Promise<{ program: LoyaltySettings; config: unknown; name: string; currency: string }> {
  const [st] = await tx.select({ config: s.store.config, name: s.store.name, currency: s.store.currency }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
  return { program: loyaltySettingsFromConfig(st?.config), config: st?.config, name: st?.name ?? '', currency: st?.currency ?? 'USD' };
}

/** Post one bonus credit. Idempotent on sourceRef; returns the ledger id when
 *  this call posted it, null when it already existed (or points <= 0). */
export async function postBonus(tx: Tx, input: {
  storeId: string; customerId: string; points: number; rule: BonusRule; sourceRef: string;
  expiryDays: number | null; orderId?: string | null; metadata?: Record<string, unknown>; actor?: string; at?: Date;
}): Promise<string | null> {
  if (!Number.isSafeInteger(input.points) || input.points <= 0) return null;
  const at = input.at ?? new Date();
  await lockCustomerLoyalty(tx, input.storeId, input.customerId);
  const [row] = await tx.insert(s.loyaltyLedger).values({
    storeId: input.storeId, customerId: input.customerId, orderId: input.orderId ?? null, kind: 'bonus',
    points: input.points, expiresAt: expiryFrom(at, input.expiryDays), sourceRef: input.sourceRef,
    actor: input.actor ?? `system:bonus-${input.rule}`, reason: `bonus_${input.rule}`,
    metadata: { rule: input.rule, ...(input.metadata ?? {}) }, createdAt: at,
  }).onConflictDoNothing().returning({ id: s.loyaltyLedger.id });
  return row?.id ?? null;
}

/** Review approved → bonus to the reviewer. Registered customers only; with
 *  reviewBonusVerifiedOnly (default) only verified-buyer reviews qualify. */
export async function grantReviewBonus(tx: Tx, storeId: string, reviewId: string): Promise<{ points: number; ledgerId: string | null }> {
  const none = { points: 0, ledgerId: null };
  const [r] = await tx.select().from(s.productReview).where(eq(s.productReview.id, reviewId)).limit(1);
  if (!r || r.status !== 'approved' || !r.customerId) return none;
  const { program } = await storeProgram(tx, storeId);
  if (!program.enabled || program.reviewBonusPoints <= 0) return none;
  if (program.reviewBonusVerifiedOnly && !r.verifiedBuyer) return none;
  const [cust] = await tx.select({ id: s.customer.id, email: s.customer.email, emailVerified: s.customer.emailVerified, deletedAt: s.customer.deletedAt }).from(s.customer).where(eq(s.customer.id, r.customerId)).limit(1);
  if (!cust || cust.deletedAt) return none;
  if (program.reviewBonusVerifiedOnly) {
    // Re-validate purchase proof at grant time: provenance may have changed
    // since submission (or the stored flag predates the provenance check).
    if (!r.orderId) return none;
    const [ord] = await tx.select({ customerId: s.order.customerId, metadata: s.order.metadata }).from(s.order)
      .where(and(eq(s.order.id, r.orderId), eq(s.order.storeId, storeId))).limit(1);
    if (!ord || !customerOwnsOrder(cust, ord)) return none;
  }
  const ledgerId = await postBonus(tx, {
    storeId, customerId: r.customerId, points: program.reviewBonusPoints, rule: 'review',
    sourceRef: `bonus:review:${reviewId}`, expiryDays: program.expiryDays, metadata: { reviewId, productId: r.productId },
  });
  if (!ledgerId) return none;
  await tx.update(s.productReview).set({ bonusPoints: program.reviewBonusPoints, updatedAt: new Date() }).where(eq(s.productReview.id, reviewId));
  return { points: program.reviewBonusPoints, ledgerId };
}

/** Sign-up bonus: once per customer, when their email is verified. Only
 *  customers created on/after signupBonusSince qualify, so imported accounts
 *  are never paid retroactively. A missing signupBonusSince fails closed. */
export async function grantSignupBonus(tx: Tx, storeId: string, customerId: string): Promise<number> {
  const { program } = await storeProgram(tx, storeId);
  if (!program.enabled || program.signupBonusPoints <= 0 || !program.signupBonusSince) return 0;
  const [c] = await tx.select({ emailVerified: s.customer.emailVerified, createdAt: s.customer.createdAt, deletedAt: s.customer.deletedAt })
    .from(s.customer).where(eq(s.customer.id, customerId)).limit(1);
  if (!c || !c.emailVerified || c.deletedAt || c.createdAt < new Date(program.signupBonusSince)) return 0;
  const id = await postBonus(tx, {
    storeId, customerId, points: program.signupBonusPoints, rule: 'signup',
    sourceRef: `bonus:signup:${customerId}`, expiryDays: program.expiryDays,
  });
  return id ? program.signupBonusPoints : 0;
}

const PAID_STATES = ['Paid', 'PartiallyRefunded', 'Refunded'] as const;

/** First-order bonus: once per customer, on the first order that reaches Paid
 *  (any other paid-ish order for the customer — including imported history —
 *  disqualifies). Caller already established the order is Paid. */
export async function grantFirstOrderBonus(tx: Tx, storeId: string, orderId: string): Promise<number> {
  const { program } = await storeProgram(tx, storeId);
  if (!program.enabled || program.firstOrderBonusPoints <= 0) return 0;
  const [order] = await tx.select({ customerId: s.order.customerId, metadata: s.order.metadata }).from(s.order).where(eq(s.order.id, orderId)).limit(1);
  if (!order?.customerId) return 0;
  const [customer] = await tx.select({ id: s.customer.id, email: s.customer.email, emailVerified: s.customer.emailVerified }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1);
  if (!customerOwnsOrder(customer, order)) return 0;
  await lockCustomerLoyalty(tx, storeId, order.customerId);
  const [other] = await tx.select({ id: s.order.id }).from(s.order)
    .where(and(eq(s.order.customerId, order.customerId), ne(s.order.id, orderId), inArray(s.order.state, [...PAID_STATES]))).limit(1);
  if (other) return 0;
  const id = await postBonus(tx, {
    storeId, customerId: order.customerId, orderId, points: program.firstOrderBonusPoints, rule: 'first_order',
    sourceRef: `bonus:first_order:${order.customerId}`, expiryDays: program.expiryDays,
  });
  return id ? program.firstOrderBonusPoints : 0;
}

/**
 * Everything a newly Paid order earns, in one place: order points (snapshot
 * taken at checkout) + first-order bonus, then ONE points_earned email with
 * the new balance. Idempotent per order: the ledger rows no-op on replay and
 * the email is dedupe-keyed. Replaces the bare postEarnForPaidOrder call in
 * paid-effects.
 */
export async function postPaidOrderRewards(tx: Tx, input: {
  storeId: string; orderId: string; paidAt: Date;
  store: { name: string; currency: string; config: unknown };
}): Promise<{ earned: number; bonus: number }> {
  const earned = await postEarnForPaidOrder(tx, input.storeId, input.orderId, input.paidAt);
  const bonus = await grantFirstOrderBonus(tx, input.storeId, input.orderId);
  const total = earned + bonus;
  if (total <= 0) return { earned, bonus };
  const [order] = await tx.select({ customerId: s.order.customerId, code: s.order.code }).from(s.order).where(eq(s.order.id, input.orderId)).limit(1);
  if (!order?.customerId) return { earned, bonus };
  const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1);
  if (!cust?.email) return { earned, bonus };
  const { available } = await loyaltyBalance(tx, order.customerId);
  await enqueuePointsEarned(tx, input.storeId, input.store, cust.email, {
    points: total, balance: available,
    lines: [
      ...(earned > 0 ? [{ label: `Order ${order.code}`, points: earned }] : []),
      ...(bonus > 0 ? [{ label: BONUS_LABELS.first_order, points: bonus }] : []),
    ],
    dedupeKey: `points_earned:order:${input.orderId}`,
  });
  return { earned, bonus };
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Birthday bonus pass: customers whose stored month/day is today (UTC) get
 * one bonus per calendar year. A Feb 29 birthday is honoured on Feb 28 in
 * non-leap years. Only verified, non-deleted customers qualify. Safe to run
 * as often as the scheduler likes — source_ref carries the year.
 */
export async function grantBirthdayBonuses(tx: Tx, storeId: string, now = new Date()): Promise<number> {
  const { program, name, currency, config } = await storeProgram(tx, storeId);
  if (!program.enabled || program.birthdayBonusPoints <= 0) return 0;
  const month = now.getUTCMonth() + 1; const day = now.getUTCDate(); const year = now.getUTCFullYear();
  const days = month === 2 && day === 28 && !isLeap(year) ? [28, 29] : [day];
  const BATCH = 500;
  let granted = 0;
  let after: string | null = null; // keyset cursor: guarantees termination
  for (;;) {
    // Exclude customers already granted this year so a full batch of
    // processed customers can never starve the rest; drain until empty.
    const due: Array<{ id: string; email: string }> = await tx.select({ id: s.customer.id, email: s.customer.email }).from(s.customer)
      .where(and(
        eq(s.customer.storeId, storeId), eq(s.customer.birthMonth, month), inArray(s.customer.birthDay, days),
        eq(s.customer.emailVerified, true), sql`${s.customer.deletedAt} IS NULL`,
        after ? sql`${s.customer.id} > ${after}` : sql`true`,
        sql`NOT EXISTS (SELECT 1 FROM loyalty_ledger ll WHERE ll.store_id = ${storeId} AND ll.customer_id = ${s.customer.id} AND ll.source_ref = 'bonus:birthday:' || ${s.customer.id}::text || ':' || ${String(year)})`,
      ))
      .orderBy(s.customer.id).limit(BATCH);
    for (const c of due) {
      const id = await postBonus(tx, {
        storeId, customerId: c.id, points: program.birthdayBonusPoints, rule: 'birthday',
        sourceRef: `bonus:birthday:${c.id}:${year}`, expiryDays: program.expiryDays, metadata: { year }, at: now,
      });
      if (!id) continue;
      granted++;
      const { available } = await loyaltyBalance(tx, c.id, now);
      await enqueuePointsEarned(tx, storeId, { name, currency, config }, c.email, {
        points: program.birthdayBonusPoints, balance: available,
        lines: [{ label: BONUS_LABELS.birthday, points: program.birthdayBonusPoints }],
        dedupeKey: `points_earned:bonus:${id}`,
      });
    }
    if (due.length < BATCH) break;
    after = due[due.length - 1]!.id;
  }
  return granted;
}

export class BonusReverseError extends Error {}

/** Admin reversal of one bonus grant. Posts a `reverse` row for the bonus
 *  amount (capped at the spendable balance; the unrecoverable remainder is
 *  recorded as shortfall, never a negative balance). One reversal per grant. */
export async function reverseBonus(tx: Tx, input: { storeId: string; ledgerId: string; actor: string; reason: string }): Promise<{ reversed: number; shortfall: number } | null> {
  const [row] = await tx.select().from(s.loyaltyLedger).where(and(eq(s.loyaltyLedger.id, input.ledgerId), eq(s.loyaltyLedger.storeId, input.storeId))).limit(1);
  if (!row) return null;
  if (row.kind !== 'bonus') throw new BonusReverseError('only bonus entries can be reversed here');
  await lockCustomerLoyalty(tx, input.storeId, row.customerId);
  const now = new Date();
  await postExpiry(tx, input.storeId, row.customerId, now);
  const { available } = await loyaltyBalance(tx, row.customerId, now);
  const posted = Math.min(row.points, Math.max(0, available));
  const shortfall = row.points - posted;
  const ins = await tx.insert(s.loyaltyLedger).values({
    storeId: input.storeId, customerId: row.customerId, orderId: row.orderId, kind: 'reverse', points: -posted, shortfall,
    sourceRef: `bonus_reverse:${row.id}`, actor: input.actor, reason: 'bonus_reversal',
    metadata: { reversesLedgerId: row.id, note: input.reason }, createdAt: now,
  }).onConflictDoNothing().returning({ id: s.loyaltyLedger.id });
  if (!ins.length) throw new BonusReverseError('this bonus was already reversed');
  return { reversed: posted, shortfall };
}
