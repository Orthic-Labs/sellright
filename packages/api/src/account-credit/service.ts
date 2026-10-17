/**
 * Transaction-only monetary coupon lifecycle. Every caller supplies a withStore
 * transaction; importing this module opens no database connection. Order mutators
 * take order locks before account locks. Account locks serialize every balance
 * change and hold calculation across orders/processes. No expiry sweep releases holds.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { lockOrderRowsInTx } from '../db/locks.js';
import * as s from '../db/schema.js';
import { err as logger } from '../lib/logger.js';
import { assertCents, availableCredit, equalAllocation, MAX_CREDIT_CENTS, normalizeCreditEmail, restorationAmount, validateAllocation } from './math.js';
import {
  AccountCreditError, type AccountCreditAllocation, type CreditAccount, type CreditSettlementResult,
  type CreditTransaction, type RedeemCreditInput, type ReleaseCreditInput, type ReserveCreditInput, type RestoreManualInput,
} from './types.js';

function required(value: string, max: number, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AccountCreditError('invalid_input', `${label} required within field limits`);
}
function operator(input: { operationKey: string; actor: string; reason: string }): void {
  required(input.operationKey, 153, 'Operation key'); required(input.actor, 100, 'Operator'); required(input.reason, 255, 'Reason');
}
function sourcePromotionLive(record: string | null): boolean {
  if (record === null) return true;
  try {
    const parsed: unknown = JSON.parse(record);
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      (parsed as { deletedAt?: unknown }).deletedAt == null;
  } catch { return false; }
}
function promotionLive(promotion: typeof s.promotion.$inferSelect, account: CreditAccount, now: Date): boolean {
  return promotion.storeId === account.storeId && promotion.type === 'account_credit' && promotion.enabled &&
    sourcePromotionLive(account.sourcePromotionRecord) &&
    (!promotion.startsAt || promotion.startsAt.getTime() <= now.getTime()) &&
    (!promotion.endsAt || promotion.endsAt.getTime() >= now.getTime());
}
async function lockAccount(tx: Tx, storeId: string, accountId: string): Promise<CreditAccount> {
  const [account] = await tx.select().from(s.accountCredit)
    .where(and(eq(s.accountCredit.storeId, storeId), eq(s.accountCredit.id, accountId))).for('update');
  if (!account) throw new AccountCreditError('missing', 'Credit account missing in store');
  return account;
}
async function lockOrder(tx: Tx, storeId: string, orderId: string) {
  await lockOrderRowsInTx(tx, storeId, [orderId]);
  const [order] = await tx.select().from(s.order).where(and(eq(s.order.storeId, storeId), eq(s.order.id, orderId)));
  if (!order) throw new AccountCreditError('missing', 'Credit order missing in store');
  return order;
}
async function pendingForOrder(tx: Tx, storeId: string, orderId: string) {
  const [hold] = await tx.select().from(s.accountCreditTransaction).where(and(
    eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.orderId, orderId),
    eq(s.accountCreditTransaction.kind, 'RESERVE'), eq(s.accountCreditTransaction.status, 'PENDING')));
  return hold;
}
async function priorOperation(tx: Tx, storeId: string, key: string) {
  const [prior] = await tx.select().from(s.accountCreditTransaction).where(and(
    eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.idempotencyKey, key)));
  return prior;
}
async function holdsForAccount(tx: Tx, account: CreditAccount) {
  return tx.select({ amount: s.accountCreditTransaction.amount, orderId: s.accountCreditTransaction.orderId })
    .from(s.accountCreditTransaction).where(and(eq(s.accountCreditTransaction.storeId, account.storeId),
      eq(s.accountCreditTransaction.accountCreditId, account.id), eq(s.accountCreditTransaction.kind, 'RESERVE'),
      eq(s.accountCreditTransaction.status, 'PENDING')));
}
async function available(tx: Tx, account: CreditAccount, exceptOrderId?: string) {
  return availableCredit(account.balance, await holdsForAccount(tx, account), exceptOrderId);
}
async function accountPromotion(tx: Tx, account: CreditAccount) {
  const [promotion] = await tx.select().from(s.promotion).where(and(eq(s.promotion.id, account.promotionId), eq(s.promotion.storeId, account.storeId)));
  if (!promotion) throw new AccountCreditError('missing', 'Credit promotion missing in store');
  return promotion;
}
async function insertEntry(tx: Tx, values: typeof s.accountCreditTransaction.$inferInsert): Promise<CreditTransaction> {
  const [entry] = await tx.insert(s.accountCreditTransaction).values(values).returning();
  return entry!;
}
async function setBalance(tx: Tx, account: CreditAccount, balance: number) {
  assertCents(balance, 'Balance');
  const [updated] = await tx.update(s.accountCredit).set({ balance, updatedAt: new Date() })
    .where(and(eq(s.accountCredit.storeId, account.storeId), eq(s.accountCredit.id, account.id))).returning();
  return updated!;
}
function conflict(message: string): never { throw new AccountCreditError('conflict', message); }

/** Includes disabled accounts so a code can release its own hold after disabling. */
export async function findByCode(tx: Tx, input: { storeId: string; code: string; now?: Date; includeInactive?: boolean }) {
  const matches = await tx.select({ account: s.accountCredit, promotion: s.promotion }).from(s.promotion)
    .leftJoin(s.accountCredit, and(eq(s.promotion.id, s.accountCredit.promotionId), eq(s.promotion.storeId, s.accountCredit.storeId)))
    .where(and(eq(s.promotion.storeId, input.storeId), sql`lower(${s.promotion.code}) = lower(${input.code.trim()})`));
  // Existing generic promotions have no case-insensitive unique code constraint.
  // Ambiguous code ownership must never pick an arbitrary credit.
  if (matches.length !== 1) return null;
  const found = matches[0]!;
  if (!found.account) return null;
  return input.includeInactive || promotionLive(found.promotion, found.account, input.now ?? new Date())
    ? { account: found.account, promotion: found.promotion } : null;
}

/** Read-only quote. Email/customer/session identity has no role in code eligibility. */
export async function previewAvailable(tx: Tx, input: { storeId: string; code: string; currency: string; orderId?: string; now?: Date }): Promise<number> {
  const found = await findByCode(tx, input);
  if (!found || found.account.currency !== input.currency) return 0;
  const hold = input.orderId ? await pendingForOrder(tx, input.storeId, input.orderId) : undefined;
  const ownOrder = hold?.accountCreditId === found.account.id ? input.orderId : undefined;
  if (found.account.disabled && !ownOrder) return 0;
  return available(tx, found.account, ownOrder);
}

/** AddingItems quotes live available credit; every later phase quotes the exact own hold. */
export async function currentDiscount(tx: Tx, input: {
  storeId: string; promotionId: string; currency: string; orderId?: string; phase: 'AddingItems' | 'ArrangingPayment' | 'PaymentSettled'; now?: Date;
}): Promise<number> {
  const [account] = await tx.select().from(s.accountCredit).where(and(eq(s.accountCredit.storeId, input.storeId), eq(s.accountCredit.promotionId, input.promotionId)));
  if (!account || account.currency !== input.currency || !promotionLive(await accountPromotion(tx, account), account, input.now ?? new Date())) return 0;
  const hold = input.orderId ? await pendingForOrder(tx, input.storeId, input.orderId) : undefined;
  if (hold && hold.accountCreditId !== account.id) return 0;
  if (input.phase !== 'AddingItems') return hold?.amount ?? 0;
  if (account.disabled && !hold) return 0;
  return available(tx, account, input.orderId);
}

/** New issuance only. Imports write snapshots and history directly, without this operation. */
export async function issue(tx: Tx, input: { storeId: string; email: string; amount: number; issuanceKey: string; currency?: string; code?: string }) {
  assertCents(input.amount, 'Issue amount', true);
  required(input.issuanceKey, 154, 'Issuance key');
  const emailNormalized = normalizeCreditEmail(input.email);
  // No account row exists yet. This store-scoped issuance-only advisory prevents
  // duplicate promotion creation and case-insensitive code collisions on retries.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`account-credit-issue:${input.storeId}`}, 0))`);
  const [store] = await tx.select().from(s.store).where(eq(s.store.id, input.storeId)).for('update');
  if (!store) throw new AccountCreditError('missing', 'Credit store missing');
  const currency = input.currency ?? store.currency;
  required(currency, 3, 'Currency');
  if (!/^[A-Z]{3}$/.test(currency)) throw new AccountCreditError('invalid_input', 'Currency must be an ISO code');
  const [existing] = await tx.select().from(s.accountCredit).where(and(eq(s.accountCredit.storeId, input.storeId), eq(s.accountCredit.issuanceKey, input.issuanceKey)));
  if (existing) {
    const promotion = await accountPromotion(tx, existing);
    if (existing.emailNormalized !== emailNormalized || existing.initialAmount !== input.amount || existing.currency !== currency ||
        (input.code !== undefined && promotion.code !== input.code.trim())) conflict('Issuance key conflicts with existing credit');
    return { account: existing, code: promotion.code!, created: false };
  }
  const code = input.code?.trim() ?? `ACC-${randomBytes(12).toString('hex').toUpperCase()}`;
  required(code, 200, 'Coupon code');
  const [collision] = await tx.select({ id: s.promotion.id }).from(s.promotion).where(and(eq(s.promotion.storeId, input.storeId), sql`lower(${s.promotion.code}) = lower(${code})`));
  if (collision) conflict('Coupon code already exists');
  const ranks = await tx.execute(sql`SELECT coalesce(max(stack_order), 0)::int AS rank FROM promotion WHERE store_id = ${input.storeId}`);
  const stackOrder = Number((ranks.rows[0] as { rank: number } | undefined)?.rank ?? 0) + 1;
  if (!Number.isSafeInteger(stackOrder) || stackOrder < 0 || stackOrder > MAX_CREDIT_CENTS) throw new AccountCreditError('invariant', 'Promotion stack rank exhausted');
  const [promotion] = await tx.insert(s.promotion).values({ storeId: input.storeId, code, type: 'account_credit', value: 0, enabled: true, stackOrder, discountScope: 'order' }).returning();
  const [account] = await tx.insert(s.accountCredit).values({ storeId: input.storeId, promotionId: promotion!.id, currency,
    emailNormalized, issuanceKey: input.issuanceKey, initialAmount: input.amount, balance: input.amount }).returning();
  await insertEntry(tx, { storeId: input.storeId, accountCreditId: account!.id, kind: 'ISSUE', status: 'POSTED', amount: input.amount,
    delta: input.amount, balanceAfter: input.amount, idempotencyKey: `issue:${input.issuanceKey}`, reason: 'Approved issuance' });
  return { account: account!, code, created: true };
}

export async function adjust(tx: Tx, input: { storeId: string; accountId: string; delta: number; operationKey: string; actor: string; reason: string }) {
  operator(input);
  assertCents(Math.abs(input.delta), 'Adjustment', true);
  const account = await lockAccount(tx, input.storeId, input.accountId);
  const key = `adjust:${input.operationKey}`;
  const prior = await priorOperation(tx, input.storeId, key);
  if (prior) {
    if (prior.kind !== 'ADJUST' || prior.status !== 'POSTED' || prior.accountCreditId !== account.id || prior.delta !== input.delta || prior.actor !== input.actor || prior.reason !== input.reason) conflict('Adjustment key conflicts with existing operation');
    return account;
  }
  if (account.balance + input.delta < 0 || account.balance + input.delta > MAX_CREDIT_CENTS || await available(tx, account) + input.delta < 0) {
    throw new AccountCreditError('unavailable', 'Adjustment exceeds available credit or storage limit');
  }
  const updated = await setBalance(tx, account, account.balance + input.delta);
  await insertEntry(tx, { storeId: input.storeId, accountCreditId: account.id, kind: 'ADJUST', status: 'POSTED', amount: Math.abs(input.delta),
    delta: input.delta, balanceAfter: updated.balance, idempotencyKey: key, actor: input.actor, reason: input.reason });
  return updated;
}

export async function disable(tx: Tx, input: { storeId: string; accountId: string; disabled: boolean; operationKey: string; actor: string; reason: string }) {
  operator(input);
  if (typeof input.disabled !== 'boolean') throw new AccountCreditError('invalid_input', 'Disabled must be boolean');
  const account = await lockAccount(tx, input.storeId, input.accountId);
  const key = `status:${input.operationKey}`;
  const kind = input.disabled ? 'DISABLE' : 'ENABLE';
  const prior = await priorOperation(tx, input.storeId, key);
  if (prior) {
    if (prior.kind !== kind || prior.status !== 'POSTED' || prior.accountCreditId !== account.id || prior.actor !== input.actor || prior.reason !== input.reason) conflict('Status key conflicts with existing operation');
    return account;
  }
  const [updated] = await tx.update(s.accountCredit).set({ disabled: input.disabled, updatedAt: new Date() })
    .where(and(eq(s.accountCredit.storeId, input.storeId), eq(s.accountCredit.id, account.id))).returning();
  await insertEntry(tx, { storeId: input.storeId, accountCreditId: account.id, kind, status: 'POSTED', amount: 0, delta: 0,
    balanceAfter: account.balance, idempotencyKey: key, actor: input.actor, reason: input.reason });
  return updated!;
}

export async function reserve(tx: Tx, input: ReserveCreditInput): Promise<CreditTransaction> {
  if (input.phase !== 'ArrangingPayment') throw new AccountCreditError('invalid_input', 'Credit reserves only at payment preparation');
  assertCents(input.appliedAmount, 'Applied amount', true);
  const order = await lockOrder(tx, input.storeId, input.orderId);
  if (order.state !== 'PendingPayment') throw new AccountCreditError('unavailable', 'Credit order is not awaiting payment');
  const account = await lockAccount(tx, input.storeId, input.accountId);
  const hold = await pendingForOrder(tx, input.storeId, input.orderId);
  const promotion = await accountPromotion(tx, account);
  if (order.currency !== account.currency || order.promotionId !== account.promotionId || !promotionLive(promotion, account, input.now ?? new Date()) ||
      (account.disabled && !hold) || (hold && hold.accountCreditId !== account.id)) {
    throw new AccountCreditError('unavailable', 'Credit unavailable for this checkout');
  }
  if (order.grandTotal <= 0) throw new AccountCreditError('unavailable', 'Credit checkout needs a payable shipping or tax balance');
  if (input.appliedAmount > await available(tx, account, order.id)) throw new AccountCreditError('unavailable', 'Credit amount changed; reapply coupon');
  if (hold?.amount === input.appliedAmount) return hold;
  if (hold) await tx.update(s.accountCreditTransaction).set({ status: 'VOID', updatedAt: new Date() })
    .where(and(eq(s.accountCreditTransaction.storeId, input.storeId), eq(s.accountCreditTransaction.id, hold.id)));
  return insertEntry(tx, { storeId: input.storeId, accountCreditId: account.id, orderId: order.id, orderCode: order.code,
    kind: 'RESERVE', status: 'PENDING', amount: input.appliedAmount, delta: 0, balanceAfter: null,
    relatedTransactionId: hold?.id ?? null, idempotencyKey: `hold:${randomUUID()}` });
}

/** Provider settlement must already be persisted in this transaction. */
export async function redeem(tx: Tx, input: RedeemCreditInput): Promise<CreditTransaction | null> {
  assertCents(input.appliedAmount, 'Applied amount');
  const order = await lockOrder(tx, input.storeId, input.orderId);
  const hold = await pendingForOrder(tx, input.storeId, input.orderId);
  if (!hold) {
    const prior = await redemptionForOrder(tx, input.storeId, input.orderId);
    if (prior && (prior.amount !== input.appliedAmount || !equalAllocation(prior.operationalAllocation, input.allocation))) conflict('Settlement replay differs from posted redemption');
    return prior ?? null;
  }
  const account = await lockAccount(tx, input.storeId, hold.accountCreditId);
  const [payment] = await tx.select({ id: s.payment.id }).from(s.payment).where(and(eq(s.payment.storeId, input.storeId), eq(s.payment.orderId, order.id), eq(s.payment.state, 'Settled'))).limit(1);
  if (!payment) throw new AccountCreditError('unavailable', 'Credit redemption requires settled payment');
  if (order.currency !== account.currency || (input.appliedAmount > 0 && order.promotionId !== account.promotionId) || input.appliedAmount > hold.amount) throw new AccountCreditError('invariant', 'Settled credit does not match hold');
  if (input.appliedAmount === 0) {
    await voidHold(tx, hold);
    await releaseEntry(tx, hold, hold.amount, 'No credit applied at settlement');
    return null;
  }
  const lines = await tx.select({ id: s.orderLine.id, quantity: s.orderLine.quantity }).from(s.orderLine)
    .where(and(eq(s.orderLine.storeId, input.storeId), eq(s.orderLine.orderId, order.id)));
  validateAllocation(input.allocation, lines, input.appliedAmount);
  if (account.balance < input.appliedAmount) throw new AccountCreditError('invariant', 'Credit balance invariant broken');
  const updated = await setBalance(tx, account, account.balance - input.appliedAmount);
  await tx.update(s.accountCreditTransaction).set({ status: 'POSTED', updatedAt: new Date() })
    .where(and(eq(s.accountCreditTransaction.storeId, input.storeId), eq(s.accountCreditTransaction.id, hold.id)));
  const entry = await insertEntry(tx, { storeId: input.storeId, accountCreditId: account.id, orderId: order.id, orderCode: order.code,
    kind: 'REDEEM', status: 'POSTED', amount: input.appliedAmount, delta: -input.appliedAmount, balanceAfter: updated.balance,
    relatedTransactionId: hold.id, idempotencyKey: `redeem:${hold.id}`, reason: 'Payment settled',
    allocation: JSON.stringify(input.allocation), operationalAllocation: input.allocation });
  if (input.appliedAmount < hold.amount) await releaseEntry(tx, hold, hold.amount - input.appliedAmount, 'Unused reserved credit');
  return entry;
}
async function voidHold(tx: Tx, hold: CreditTransaction) {
  await tx.update(s.accountCreditTransaction).set({ status: 'VOID', updatedAt: new Date() })
    .where(and(eq(s.accountCreditTransaction.storeId, hold.storeId), eq(s.accountCreditTransaction.id, hold.id)));
}
async function releaseEntry(tx: Tx, hold: CreditTransaction, amount: number, reason: string) {
  return insertEntry(tx, { storeId: hold.storeId, accountCreditId: hold.accountCreditId, orderId: hold.orderId, orderCode: hold.orderCode,
    kind: 'RELEASE', status: 'POSTED', amount, delta: 0, idempotencyKey: `release:${hold.id}`, relatedTransactionId: hold.id, reason });
}

/** Release only explicit cancellation or removal of the matching code. */
export async function release(tx: Tx, input: ReleaseCreditInput): Promise<boolean> {
  const order = await lockOrder(tx, input.storeId, input.orderId);
  if (input.cause !== 'cancelled' && input.cause !== 'coupon_removed') throw new AccountCreditError('invalid_input', 'Unsupported credit release cause');
  if (input.cause === 'cancelled' && order.state !== 'Cancelled') throw new AccountCreditError('unavailable', 'Credit cancellation requires cancelled order');
  const hold = await pendingForOrder(tx, input.storeId, input.orderId);
  if (!hold) return false;
  const account = await lockAccount(tx, input.storeId, hold.accountCreditId);
  if (input.cause === 'coupon_removed') {
    const promotion = await accountPromotion(tx, account);
    if (promotion.code?.toLowerCase() !== input.couponCode.trim().toLowerCase()) return false;
  }
  await voidHold(tx, hold);
  await releaseEntry(tx, hold, hold.amount, input.cause === 'cancelled' ? 'Order cancelled' : 'Coupon removed');
  return true;
}

async function redemptionForOrder(tx: Tx, storeId: string, orderId: string, accountId?: string) {
  const entries = await tx.select().from(s.accountCreditTransaction).where(and(eq(s.accountCreditTransaction.storeId, storeId),
    eq(s.accountCreditTransaction.orderId, orderId), eq(s.accountCreditTransaction.kind, 'REDEEM'), eq(s.accountCreditTransaction.status, 'POSTED'),
    accountId ? eq(s.accountCreditTransaction.accountCreditId, accountId) : undefined));
  if (entries.length > 1) conflict('Multiple redemptions require explicit reconciliation');
  return entries[0];
}
async function postRestoration(tx: Tx, account: CreditAccount, redeem: CreditTransaction, input: {
  orderId: string; orderLineId: string; quantity: number; key: string; reason: string; actor: string | null; refundId: string | null; expectedCents?: number;
}) {
  const priorByKey = await priorOperation(tx, account.storeId, input.key);
  // Imported keys retain source numeric IDs. Native UUID keys cannot identify
  // those operations, so settled refunds also bind to proven mapped business
  // identity. Account + order locks already serialize every possible posting.
  const priorByRefund = input.refundId === null ? [] : await tx.select().from(s.accountCreditTransaction).where(and(
    eq(s.accountCreditTransaction.storeId, account.storeId), eq(s.accountCreditTransaction.accountCreditId, account.id),
    eq(s.accountCreditTransaction.orderId, input.orderId), eq(s.accountCreditTransaction.refundId, input.refundId),
    eq(s.accountCreditTransaction.orderLineId, input.orderLineId), eq(s.accountCreditTransaction.kind, 'RESTORE'),
    eq(s.accountCreditTransaction.status, 'POSTED')));
  if (priorByRefund.length > 1 || (priorByKey && priorByRefund[0] && priorByKey.id !== priorByRefund[0].id)) {
    conflict('Restoration identity conflicts with existing operations');
  }
  const prior = priorByKey ?? priorByRefund[0];
  if (prior) {
    if (prior.kind !== 'RESTORE' || prior.status !== 'POSTED' || prior.accountCreditId !== account.id || prior.relatedTransactionId !== redeem.id ||
        prior.orderId !== input.orderId || prior.orderLineId !== input.orderLineId || prior.quantity !== input.quantity || prior.actor !== input.actor ||
        prior.reason !== input.reason || prior.refundId !== input.refundId || prior.delta !== prior.amount ||
        (input.expectedCents !== undefined && prior.amount !== input.expectedCents)) {
      conflict('Restoration key conflicts with existing operation');
    }
    const units = redeem.operationalAllocation?.[input.orderLineId];
    if (!Array.isArray(units)) throw new AccountCreditError('allocation', 'Proven credit allocation missing for returned line');
    const restoredLine = await tx.select().from(s.accountCreditTransaction).where(and(
      eq(s.accountCreditTransaction.storeId, account.storeId), eq(s.accountCreditTransaction.accountCreditId, account.id),
      eq(s.accountCreditTransaction.orderId, input.orderId), eq(s.accountCreditTransaction.orderLineId, input.orderLineId),
      eq(s.accountCreditTransaction.kind, 'RESTORE'), eq(s.accountCreditTransaction.status, 'POSTED')));
    const restoredQuantity = restoredLine.reduce((sum, row) => sum + (row.quantity ?? Number.NaN), 0);
    const restoredAmount = restoredLine.reduce((sum, row) => sum + row.amount, 0);
    // Exact source restoration consumes a prefix of the immutable unit vector.
    // Its cumulative amount proves replay integrity even after later refunds,
    // without guessing operation order from timestamps or idempotency strings.
    if (!Number.isSafeInteger(restoredQuantity) || restoredQuantity < 1 || restoredQuantity > units.length ||
        !Number.isSafeInteger(restoredAmount) || restoredAmount > redeem.amount ||
        restoredLine.some(row => !Number.isSafeInteger(row.quantity) || row.quantity! < 1 || row.delta !== row.amount || row.relatedTransactionId !== redeem.id) ||
        restoredAmount !== restorationAmount(units, 0, restoredQuantity)) {
      conflict('Restoration amount conflicts with original unit allocation');
    }
    return prior;
  }
  const [line] = await tx.select({ id: s.orderLine.id }).from(s.orderLine).where(and(eq(s.orderLine.storeId, account.storeId), eq(s.orderLine.orderId, input.orderId), eq(s.orderLine.id, input.orderLineId)));
  if (!line || !redeem.orderId || redeem.orderId !== input.orderId) throw new AccountCreditError('allocation', 'Proven linked order line required for restoration');
  const units = redeem.operationalAllocation?.[input.orderLineId];
  if (!Array.isArray(units)) throw new AccountCreditError('allocation', 'Proven credit allocation missing for returned line');
  const restored = await tx.select().from(s.accountCreditTransaction).where(and(eq(s.accountCreditTransaction.storeId, account.storeId),
    eq(s.accountCreditTransaction.accountCreditId, account.id), eq(s.accountCreditTransaction.orderId, input.orderId),
    eq(s.accountCreditTransaction.kind, 'RESTORE'), eq(s.accountCreditTransaction.status, 'POSTED')));
  // A historical restoration without a proven target line cannot safely identify
  // which units remain. Preserve its balance and demand explicit reconciliation.
  if (restored.some(row => !row.orderLineId || row.quantity === null)) throw new AccountCreditError('allocation', 'Historical restoration lacks proven unit linkage');
  const quantity = restored.filter(row => row.orderLineId === input.orderLineId).reduce((sum, row) => sum + row.quantity!, 0);
  const amount = restorationAmount(units, quantity, input.quantity, input.expectedCents);
  const total = restored.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isSafeInteger(total) || total + amount > redeem.amount) throw new AccountCreditError('invariant', 'Restoration exceeds redeemed credit');
  const updated = await setBalance(tx, account, account.balance + amount);
  const entry = await insertEntry(tx, { storeId: account.storeId, accountCreditId: account.id, orderId: input.orderId, orderCode: redeem.orderCode,
    kind: 'RESTORE', status: 'POSTED', amount, delta: amount, balanceAfter: updated.balance, relatedTransactionId: redeem.id,
    orderLineId: input.orderLineId, quantity: input.quantity, refundId: input.refundId, idempotencyKey: input.key, reason: input.reason, actor: input.actor });
  // Multiple lines in one refund share the same locked account object.
  account.balance = updated.balance;
  return entry;
}

export async function restoreRefund(tx: Tx, input: { storeId: string; orderId: string; refundId: string }): Promise<CreditTransaction[]> {
  await lockOrder(tx, input.storeId, input.orderId);
  const [refund] = await tx.select().from(s.refund).where(and(eq(s.refund.storeId, input.storeId), eq(s.refund.orderId, input.orderId), eq(s.refund.id, input.refundId)));
  if (!refund || refund.state !== 'Settled') throw new AccountCreditError('unavailable', 'Credit restoration requires settled refund in store');
  const redeem = await redemptionForOrder(tx, input.storeId, input.orderId);
  if (!redeem) return [];
  const account = await lockAccount(tx, input.storeId, redeem.accountCreditId);
  const lines = await tx.select().from(s.refundLine).where(and(eq(s.refundLine.storeId, input.storeId), eq(s.refundLine.refundId, input.refundId)));
  const entries: CreditTransaction[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.orderLineId)) conflict('Refund repeats an order line');
    seen.add(line.orderLineId);
    entries.push(await postRestoration(tx, account, redeem, { orderId: input.orderId, orderLineId: line.orderLineId, quantity: line.quantity,
      key: `refund:${input.refundId}:line:${line.orderLineId}`, reason: 'Settled merchandise refund', actor: null, refundId: input.refundId }));
  }
  return entries;
}
export async function restoreManual(tx: Tx, input: RestoreManualInput): Promise<CreditTransaction> {
  operator(input); assertCents(input.expectedCents, 'Expected restoration');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new AccountCreditError('invalid_input', 'Positive return quantity required');
  await lockOrder(tx, input.storeId, input.orderId);
  const redeem = await redemptionForOrder(tx, input.storeId, input.orderId, input.accountId);
  if (!redeem) throw new AccountCreditError('missing', 'No redeemed credit on linked order');
  const account = await lockAccount(tx, input.storeId, input.accountId);
  return postRestoration(tx, account, redeem, { ...input, key: `manual:${input.operationKey}`, refundId: null });
}

/**
 * Savepoint keeps an already-settled payment/refund successful even if SQL credit
 * posting fails. A rolled-back redemption leaves its PENDING hold unavailable.
 * Call only after provider outcome is persisted, on the same transaction.
 */
async function afterSettlement<T>(tx: Tx, input: { storeId: string; orderId: string; refundId?: string }, operation: 'redeem' | 'restore_refund', fn: () => Promise<T>): Promise<CreditSettlementResult<T>> {
  await tx.execute(sql`SAVEPOINT account_credit_post_settlement`);
  try {
    const value = await fn();
    await tx.execute(sql`RELEASE SAVEPOINT account_credit_post_settlement`);
    return { ok: true, value };
  } catch (error) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT account_credit_post_settlement`);
    await tx.execute(sql`RELEASE SAVEPOINT account_credit_post_settlement`);
    const result = { ok: false as const, event: 'account_credit.reconciliation_required' as const, operation, ...input,
      errorCode: error instanceof AccountCreditError ? error.code : 'posting_failed' };
    // Log identifiers + bounded codes only: no coupon, issuance email, or raw query.
    logger.error('Account credit requires reconciliation', undefined, result);
    return result;
  }
}
export function redeemAfterSettlement(tx: Tx, input: RedeemCreditInput) {
  return afterSettlement(tx, { storeId: input.storeId, orderId: input.orderId }, 'redeem', () => redeem(tx, input));
}
export function restoreRefundAfterSettlement(tx: Tx, input: { storeId: string; orderId: string; refundId: string }) {
  return afterSettlement(tx, input, 'restore_refund', () => restoreRefund(tx, input));
}
