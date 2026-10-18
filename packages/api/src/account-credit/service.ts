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
import { readCurrentOrderPricingSnapshot } from '../money/current-credit-pricing.js';
import { buildImportedCreditOrigin, decodeCreditPricingOrigin, isImportedCreditOrigin } from '../money/imported-credit-origin.js';
import { assertNoPendingOrderEdit, isPendingEditStage, readEditStageProposal } from '../orders/edit-stage.js';
import { orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { err as logger } from '../lib/logger.js';
import { assertCents, availableCredit, equalAllocation, MAX_CREDIT_CENTS, normalizeCreditEmail, validateAllocation } from './math.js';
import { planCreditUnitReturn, planEditCreditFunding, readCreditFundingState, readCreditUnitReturns, readCreditRefundEvidence, creditReturnSnapshotDigest, type EditFundingInput, type EditFundingPosting } from './edit-funding.js';
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
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

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
/** Load potential restorations without filtering malformed identities/statuses away. */
export async function readCreditFundingEvidence(tx: Tx, input: { storeId: string; orderId: string }) {
  const redemption = await redemptionForOrder(tx, input.storeId, input.orderId);
  if (!redemption) return null;
  const history = await tx.select().from(s.accountCreditTransaction).where(and(
    eq(s.accountCreditTransaction.storeId, input.storeId), eq(s.accountCreditTransaction.orderId, input.orderId),
    eq(s.accountCreditTransaction.kind, 'RESTORE')));
  return { redemption, history, historyComplete: true as const };
}
/** Complete native-unit custody & durable edit-source evidence for every reader. */
export async function readCurrentCreditEvidence(tx: Tx, input: { storeId: string; orderId: string }) {
  const funding = await readCreditFundingEvidence(tx, input);
  if (!funding) return null;
  const [account] = await tx.select().from(s.accountCredit).where(and(eq(s.accountCredit.storeId, input.storeId), eq(s.accountCredit.id, funding.redemption.accountCreditId)));
  if (!account) throw new AccountCreditError('allocation', 'Credit source account is missing');
  const [promotion] = await tx.select({ id: s.promotion.id, storeId: s.promotion.storeId, type: s.promotion.type }).from(s.promotion)
    .where(and(eq(s.promotion.storeId, input.storeId), eq(s.promotion.id, account.promotionId)));
  if (!promotion || promotion.type !== 'account_credit') throw new AccountCreditError('allocation', 'Credit source promotion linkage differs');
  const importedSource = account.sourceKey !== null || account.sourceId !== null || funding.redemption.sourceKey !== null || funding.redemption.sourceId !== null ? {
    accountSource: { id: account.id, storeId: account.storeId, promotionId: account.promotionId, currency: account.currency,
      sourceKey: account.sourceKey, sourceId: account.sourceId, sourceRecord: account.sourceRecord,
      sourcePromotionRecord: account.sourcePromotionRecord, sourceDigest: account.sourceDigest, promotion },
    redemptionSource: { id: funding.redemption.id, storeId: funding.redemption.storeId, orderId: funding.redemption.orderId,
      accountCreditId: funding.redemption.accountCreditId, kind: funding.redemption.kind, status: funding.redemption.status,
      amount: funding.redemption.amount, delta: funding.redemption.delta, operationalAllocation: funding.redemption.operationalAllocation,
      sourceKey: funding.redemption.sourceKey, sourceId: funding.redemption.sourceId, sourceRecord: funding.redemption.sourceRecord,
      sourceDigest: funding.redemption.sourceDigest, allocation: funding.redemption.allocation, sourceOrderId: funding.redemption.sourceOrderId },
  } : undefined;
  const refunds = await tx.select().from(s.refund).where(and(eq(s.refund.storeId, input.storeId), eq(s.refund.orderId, input.orderId)));
  const lines = await tx.select({ id: s.refundLine.id, refundId: s.refundLine.refundId, orderLineId: s.refundLine.orderLineId,
    quantity: s.refundLine.quantity, amount: s.refundLine.amount }).from(s.refundLine)
    .innerJoin(s.refund, and(eq(s.refund.id, s.refundLine.refundId), eq(s.refund.storeId, s.refundLine.storeId)))
    .where(and(eq(s.refundLine.storeId, input.storeId), eq(s.refund.orderId, input.orderId)));
  const pricingSources = await tx.select({ id: s.orderEdit.id, orderId: s.orderEdit.orderId, fingerprint: s.orderEdit.fingerprint, before: s.orderEdit.before,
    after: s.orderEdit.after, settlement: s.orderEdit.settlement }).from(s.orderEdit)
    .where(and(eq(s.orderEdit.storeId, input.storeId), eq(s.orderEdit.orderId, input.orderId)));
  const evidence = { ...funding, refunds: refunds.map(refund => ({ id: refund.id, state: refund.state, metadata: refund.metadata, amount: refund.amount,
    lines: lines.filter(line => line.refundId === refund.id).map(({ id, orderLineId, quantity, amount }) => ({ id, orderLineId, quantity, amount })) })),
    refundsComplete: true as const, pricingSources, ...(importedSource ? { importedSource } : {}) };
  if (!importedSource) return { ...evidence, importedOrigin: undefined };
  const [order] = await tx.select().from(s.order).where(and(eq(s.order.storeId, input.storeId), eq(s.order.id, input.orderId)));
  if (!order) throw new AccountCreditError('allocation', 'Imported credit order is missing');
  if (order.pricingSnapshot !== null) {
    if (!isImportedCreditOrigin(order.pricingSnapshot)) return { ...evidence, importedOrigin: undefined };
    decodeCreditPricingOrigin(order.pricingSnapshot, evidence);
    return { ...evidence, importedOrigin: order.pricingSnapshot };
  }
  const nativeLines = await tx.select({ id: s.orderLine.id, storeId: s.orderLine.storeId, orderId: s.orderLine.orderId,
    quantity: s.orderLine.quantity, unitPrice: s.orderLine.unitPrice, lineSubtotal: s.orderLine.lineSubtotal,
    lineDiscount: s.orderLine.lineDiscount, lineTax: s.orderLine.lineTax, lineTotal: s.orderLine.lineTotal, metadata: s.orderLine.metadata })
    .from(s.orderLine).where(and(eq(s.orderLine.storeId, input.storeId), eq(s.orderLine.orderId, input.orderId)));
  const metadata = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? order.metadata as Record<string, unknown> : {};
  const loyalty = metadata.loyalty && typeof metadata.loyalty === 'object' && !Array.isArray(metadata.loyalty) ? metadata.loyalty as Record<string, unknown> : {};
  const pointsDiscount = loyalty.pointsDiscount ?? 0;
  if (typeof pointsDiscount !== 'number' || !Number.isSafeInteger(pointsDiscount) || pointsDiscount < 0 || pointsDiscount > MAX_CREDIT_CENTS) {
    throw new AccountCreditError('allocation', 'Imported credit loyalty money is invalid');
  }
  const totals = { subtotal: order.subtotal, discountTotal: order.discountTotal,
    shippingTotal: order.shippingTotal, taxTotal: order.taxTotal, grandTotal: order.grandTotal, pointsDiscount };
  const pending = pricingSources.filter(row => isPendingEditStage(row.settlement));
  if (pending.length) {
    const invalid = (): never => { throw new AccountCreditError('allocation', 'Pending imported origin proof differs'); };
    if (pending.length !== 1) invalid();
    const row = pending[0]!;
    const before = row.before, after = row.after;
    if (!record(before) || !record(after)) invalid();
    const storedOrder = before.storedOrder, importedOrigin = before.currentPricing, beforeLines = before.financialLines;
    if (!isImportedCreditOrigin(importedOrigin) || !record(storedOrder) || !Array.isArray(beforeLines)) invalid();
    const proposal = readEditStageProposal(after.proposal), activation = proposal.activation;
    const equal = (left: unknown, right: unknown) => orderEditStoredFingerprint(left) === orderEditStoredFingerprint(right);
    if (row.orderId !== input.orderId || proposal.editId !== row.id || proposal.orderId !== row.orderId ||
      proposal.requestFingerprint !== row.fingerprint || proposal.beforeFingerprint !== before.storedFingerprint ||
      importedOrigin.orderId !== input.orderId || importedOrigin.storeId !== input.storeId ||
      !record(activation) || !record(activation.predecessor) || !equal(activation.beforeOrder, storedOrder) ||
      !equal(activation.origin, importedOrigin) || !equal(activation.predecessor.snapshot, importedOrigin)) invalid();
    // A durable row is not source authority by itself: bind its financial capture
    // to live DB facts, then rebuild only its independently proven frozen prefix.
    const financialOrder = (value: unknown) => {
      if (!record(value)) return invalid();
      const meta = record(value.metadata) ? value.metadata : {}, loyalty = record(meta.loyalty) ? meta.loyalty : {};
      return { ...Object.fromEntries(['id', 'storeId', 'currency', 'couponCodes', 'subtotal', 'discountTotal', 'shippingTotal', 'taxTotal', 'grandTotal'].map(key => [key, value[key]])),
        pointsDiscount: loyalty.pointsDiscount ?? 0, sourceMetadata: meta.vendure };
    };
    const lineFields = ['id', 'storeId', 'orderId', 'quantity', 'unitPrice', 'lineSubtotal', 'lineDiscount', 'lineTax', 'lineTotal', 'metadata'];
    const financialLines = beforeLines.map((value: unknown) => {
      if (!record(value)) return invalid();
      return Object.fromEntries(lineFields.map(key => [key, value[key]]));
    });
    const sorted = <T extends { id: unknown }>(values: T[]) => [...values].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (!equal(financialOrder(storedOrder), financialOrder(order)) ||
      !equal(financialLines.sort((left, right) => String(left.id).localeCompare(String(right.id))), sorted(nativeLines))) invalid();
    decodeCreditPricingOrigin(importedOrigin, evidence);
    const prefixIds = new Set(importedOrigin.capture.restoreIds);
    const capturedEvidence = { ...evidence, history: evidence.history.filter(row => prefixIds.has(row.id)), refunds: importedOrigin.capture.legacyRefunds };
    const capturedLines = importedOrigin.capture.lines.map(line => nativeLines.find(actual => actual.id === line.id) ?? invalid());
    if (capturedLines.length !== nativeLines.length) invalid();
    const canonical = buildImportedCreditOrigin({ ...input, currency: order.currency, metadata: order.metadata,
      couponCodes: order.couponCodes, totals, lines: capturedLines, evidence: capturedEvidence, ...importedSource });
    if (!equal(canonical, importedOrigin) || proposal.beforeLedgerPrefixDigest !== orderEditStoredFingerprint({
      redemption: evidence.redemption, history: [...capturedEvidence.history].sort((left, right) => left.id.localeCompare(right.id)) })) invalid();
    const predecessor = readCurrentOrderPricingSnapshot(importedOrigin, { currency: order.currency, orderLines: nativeLines,
      totals, mode: 'settlement', creditEvidence: { ...capturedEvidence, importedOrigin } });
    if (!predecessor || !equal(activation.predecessor, predecessor)) invalid();
    readCurrentOrderPricingSnapshot(importedOrigin, { currency: order.currency, orderLines: nativeLines, totals,
      mode: 'settlement', creditEvidence: { ...evidence, importedOrigin }, pricingSources });
    return { ...evidence, importedOrigin };
  }
  const importedOrigin = buildImportedCreditOrigin({ ...input, currency: order.currency, metadata: order.metadata,
    couponCodes: order.couponCodes, totals,
    lines: nativeLines, evidence, ...importedSource });
  return { ...evidence, importedOrigin };
}
/** Adopt retained source custody once, before any new refund or return changes
 * its captured history. Call inside the same transaction as preparation. */
export async function anchorImportedCreditOrigin(tx: Tx, input: { storeId: string; orderId: string }) {
  let order = await lockOrder(tx, input.storeId, input.orderId);
  const redemption = await redemptionForOrder(tx, input.storeId, input.orderId);
  if (redemption) await lockAccount(tx, input.storeId, redemption.accountCreditId);
  let evidence = await readCurrentCreditEvidence(tx, input);
  if (order.pricingSnapshot !== null || !evidence?.importedOrigin) return { order, evidence };
  const lines = await tx.select({ id: s.orderLine.id, quantity: s.orderLine.quantity }).from(s.orderLine)
    .where(and(eq(s.orderLine.storeId, input.storeId), eq(s.orderLine.orderId, input.orderId)));
  readCurrentOrderPricingSnapshot(evidence.importedOrigin, { currency: order.currency, orderLines: lines,
    mode: 'refund', creditEvidence: evidence, pricingSources: evidence.pricingSources });
  await tx.update(s.order).set({ pricingSnapshot: evidence.importedOrigin }).where(and(eq(s.order.storeId, input.storeId),
    eq(s.order.id, input.orderId), sql`${s.order.pricingSnapshot} IS NULL`));
  order = await lockOrder(tx, input.storeId, input.orderId);
  evidence = await readCurrentCreditEvidence(tx, input);
  if (!evidence || order.pricingSnapshot === null) conflict('Imported origin adoption lost canonical snapshot');
  readCurrentOrderPricingSnapshot(order.pricingSnapshot, { currency: order.currency, orderLines: lines,
    mode: 'refund', creditEvidence: evidence, pricingSources: evidence.pricingSources });
  return { order, evidence };
}
type EditCreditInput = { storeId: string; orderId: string } & Pick<EditFundingInput, 'editId' | 'lines' | 'committedEdit'>;
export async function prepareEditCreditFunding(tx: Tx, input: EditCreditInput) {
  const order = await lockOrder(tx, input.storeId, input.orderId);
  const redemption = await redemptionForOrder(tx, input.storeId, input.orderId);
  if (!redemption) return null;
  const account = await lockAccount(tx, input.storeId, redemption.accountCreditId);
  if (account.currency !== order.currency) conflict('Credit funding currency differs from order');
  const evidence = (await readCreditFundingEvidence(tx, input))!;
  const plan = planEditCreditFunding({ ...input, ...evidence });
  if (!plan.ok) throw new AccountCreditError('allocation', plan.message);
  return { redemptionId: redemption.id, plan, evidence };
}
async function postFundingRows(tx: Tx, account: CreditAccount, redemption: CreditTransaction,
  postings: readonly EditFundingPosting[], extra: { refundId?: string | null; actor?: string | null; reason: string }) {
  const entries: CreditTransaction[] = [];
  for (const posting of postings) {
    const updated = await setBalance(tx, account, account.balance + posting.amount);
    entries.push(await insertEntry(tx, { ...posting, storeId: account.storeId, orderCode: redemption.orderCode,
      balanceAfter: updated.balance, refundId: extra.refundId ?? null, actor: extra.actor ?? null, reason: extra.reason }));
    account.balance = updated.balance;
  }
  return entries;
}
/** Activation transaction owns durable edit receipt together with these postings. */
export async function postEditCreditFunding(tx: Tx, input: EditCreditInput) {
  const prepared = await prepareEditCreditFunding(tx, input);
  if (!prepared || prepared.plan.replay) return prepared;
  const account = await lockAccount(tx, input.storeId, prepared.evidence.redemption.accountCreditId);
  await postFundingRows(tx, account, prepared.evidence.redemption, prepared.plan.postings,
    { reason: 'Committed order edit', actor: null, refundId: null });
  return prepared;
}
async function postRestoration(tx: Tx, account: CreditAccount, redeem: CreditTransaction, input: {
  orderId: string; orderLineId: string; quantity: number; key: string; reason: string; actor: string | null; refundId: string | null;
  expectedCents?: number; originalIndexes?: readonly (number | null)[];
}) {
  const evidence = (await readCreditFundingEvidence(tx, { storeId: account.storeId, orderId: input.orderId }))!;
  const state = readCreditFundingState(evidence);
  if (!state.ok) throw new AccountCreditError('allocation', `Proven credit allocation missing or restoration conflicts: ${state.message}`);
  const priorByKey = await priorOperation(tx, account.storeId, input.key);
  const byRefund = input.refundId === null ? [] : evidence.history.filter(row => row.refundId === input.refundId && row.orderLineId === input.orderLineId);
  if (byRefund.length > 1 || (priorByKey && byRefund[0] && priorByKey.id !== byRefund[0].id)) conflict('Restoration identity conflicts with existing operations');
  const prior = priorByKey ?? byRefund[0];
  if (prior) {
    const originalQuantity = input.originalIndexes?.filter(i => i !== null).length ?? input.quantity;
    if (prior.kind !== 'RESTORE' || prior.status !== 'POSTED' || prior.accountCreditId !== account.id || prior.relatedTransactionId !== redeem.id ||
      prior.orderId !== input.orderId || prior.orderLineId !== input.orderLineId || prior.quantity !== originalQuantity ||
      prior.actor !== input.actor || prior.reason !== input.reason || prior.refundId !== input.refundId ||
      (input.expectedCents !== undefined && prior.amount !== input.expectedCents)) conflict('Restoration key conflicts with existing operation');
    if (input.originalIndexes && prior.allocation) {
      const envelope = JSON.parse(prior.allocation) as { type?: string; units?: Array<{ index: number }> };
      if (envelope.type === 'account_credit.unit_restore' && JSON.stringify(envelope.units?.map(u => u.index)) !==
        JSON.stringify(input.originalIndexes.filter(i => i !== null))) conflict('Restoration key conflicts with selected units');
    }
    return prior;
  }
  const [line] = await tx.select({ id: s.orderLine.id }).from(s.orderLine).where(and(eq(s.orderLine.storeId, account.storeId),
    eq(s.orderLine.orderId, input.orderId), eq(s.orderLine.id, input.orderLineId)));
  if (!line || redeem.orderId !== input.orderId) throw new AccountCreditError('allocation', 'Proven linked order line required for restoration');
  // Legacy unchanged units have an identity mapping; residual state, never summed
  // return quantity, selects their still-unconsumed original indexes.
  const indexes = input.originalIndexes ?? state.state.remaining[input.orderLineId]?.map((_, i) => i)
    .filter(i => !state.state.returnedIndexes[input.orderLineId]!.includes(i)).slice(0, input.quantity);
  if (!indexes || indexes.length !== input.quantity) throw new AccountCreditError('allocation', 'Proven credit allocation missing for returned units');
  const plan = planCreditUnitReturn({ ...evidence, orderLineId: input.orderLineId, originalIndexes: indexes,
    operation: input.refundId ? { kind: 'refund', id: input.refundId } : { kind: 'manual_return', id: input.key.slice('manual:'.length) } });
  if (!plan.ok) throw new AccountCreditError('allocation', plan.message);
  if (!plan.posting) {
    if (input.expectedCents !== undefined && input.expectedCents !== 0) conflict('Unfunded merchandise cannot restore credit');
    return null;
  }
  if (input.expectedCents !== undefined && plan.posting.amount !== input.expectedCents) conflict('Restoration amount conflicts with expected cents');
  return (await postFundingRows(tx, account, redeem, [plan.posting], input))[0]!;
}

export async function restoreRefund(tx: Tx, input: { storeId: string; orderId: string; refundId: string }): Promise<CreditTransaction[]> {
  const order = await lockOrder(tx, input.storeId, input.orderId);
  const [refund] = await tx.select().from(s.refund).where(and(eq(s.refund.storeId, input.storeId), eq(s.refund.orderId, input.orderId), eq(s.refund.id, input.refundId)));
  if (!refund || refund.state !== 'Settled') throw new AccountCreditError('unavailable', 'Credit restoration requires settled refund in store');
  const redeem = await redemptionForOrder(tx, input.storeId, input.orderId);
  if (!redeem) return [];
  const account = await lockAccount(tx, input.storeId, redeem.accountCreditId);
  const lines = await tx.select().from(s.refundLine).where(and(eq(s.refundLine.storeId, input.storeId), eq(s.refundLine.refundId, input.refundId)));
  const evidence = (await readCurrentCreditEvidence(tx, input))!;
  let frozen: ReturnType<typeof readCreditUnitReturns>;
  try { frozen = readCreditRefundEvidence({ ...refund, lines }); }
  catch { throw new AccountCreditError('allocation', 'Frozen refund unit identity requires reconciliation'); }
  if (account.currency !== order.currency) conflict('Restoration currency differs from order');
  if (frozen && (frozen.redemptionId !== redeem.id || frozen.lines.length !== lines.length ||
    frozen.lines.some(unit => !lines.some(line => line.orderLineId === unit.orderLineId && line.quantity === unit.positions.length)))) {
    conflict('Frozen refund unit closure differs from refund lines');
  }
  if (!frozen && (order.pricingSnapshot as { version?: number } | null)?.version === 2) throw new AccountCreditError('allocation', 'Edited credit refund lacks frozen unit identity');
  const needsPosting = frozen?.lines.some(line => line.originalIndexes.some(index => index !== null) &&
    !evidence.history.some(row => row.refundId === refund.id && row.orderLineId === line.orderLineId));
  if (frozen && needsPosting) {
    if (frozen.version === 1 && frozen.snapshotDigest !== creditReturnSnapshotDigest(order.pricingSnapshot)) conflict('Frozen refund pricing snapshot differs');
    const current = readCurrentOrderPricingSnapshot(order.pricingSnapshot ?? evidence.importedOrigin, { currency: order.currency, orderLines: await tx.select({ id: s.orderLine.id, quantity: s.orderLine.quantity })
      .from(s.orderLine).where(and(eq(s.orderLine.storeId, input.storeId), eq(s.orderLine.orderId, order.id))), mode: 'refund', creditEvidence: evidence, pricingSources: evidence.pricingSources });
    const mapping = current ? Object.fromEntries(Object.entries(current.sourceRefundUnits).map(([line, units]) => [line, units.map(unit => unit.originalIndex)])) :
      Object.fromEntries(Object.entries(redeem.operationalAllocation ?? {}).map(([id, units]) => [id, units.map((_, i) => i)]));
    if (frozen.version === 1 && frozen.lines.some(line => line.positions.some((position, i) => mapping[line.orderLineId]?.[position] !== line.originalIndexes[i]))) conflict('Frozen refund original identity differs');
    if (frozen.version === 2 && (!current || frozen.lines.some(line => line.unitIds.some((id, i) => {
      const position = current.sourceRefundUnits[line.orderLineId]?.findIndex(unit => unit.unitId === id) ?? -1;
      return position < 0 || mapping[line.orderLineId]?.[position] !== line.originalIndexes[i];
    })))) conflict('Frozen refund stable identity differs');
  }
  const entries: CreditTransaction[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.orderLineId)) conflict('Refund repeats an order line');
    seen.add(line.orderLineId);
    const entry = await postRestoration(tx, account, redeem, { orderId: input.orderId, orderLineId: line.orderLineId, quantity: line.quantity,
      key: `refund:${input.refundId}:line:${line.orderLineId}`, reason: 'Settled merchandise refund', actor: null, refundId: input.refundId,
      ...(frozen ? { originalIndexes: frozen.lines.find(unit => unit.orderLineId === line.orderLineId)!.originalIndexes,
        expectedCents: frozen.lines.find(unit => unit.orderLineId === line.orderLineId)!.creditCents.reduce((sum, cents) => sum + cents, 0) } : {}) });
    if (entry) entries.push(entry);
  }
  return entries;
}
export async function restoreManual(tx: Tx, input: RestoreManualInput): Promise<CreditTransaction> {
  operator(input); assertCents(input.expectedCents, 'Expected restoration');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new AccountCreditError('invalid_input', 'Positive return quantity required');
  const order = await lockOrder(tx, input.storeId, input.orderId);
  try { await assertNoPendingOrderEdit(tx, input.storeId, order.id); }
  catch { conflict('Resolve pending order edit before manual credit restoration'); }
  const redeem = await redemptionForOrder(tx, input.storeId, input.orderId, input.accountId);
  if (!redeem) throw new AccountCreditError('missing', 'No redeemed credit on linked order');
  const account = await lockAccount(tx, input.storeId, input.accountId);
  if (account.currency !== order.currency) conflict('Restoration currency differs from order');
  const key = `manual:${input.operationKey}`;
  let originalIndexes: number[] | undefined;
  if (!await priorOperation(tx, input.storeId, key)) {
    const anchored = await anchorImportedCreditOrigin(tx, input);
    const evidence = anchored.evidence!, state = readCreditFundingState(evidence);
    if (!state.ok) throw new AccountCreditError('allocation', state.message);
    const current = readCurrentOrderPricingSnapshot(anchored.order.pricingSnapshot ?? evidence.importedOrigin, { currency: order.currency, orderLines: await tx.select({ id: s.orderLine.id, quantity: s.orderLine.quantity })
      .from(s.orderLine).where(and(eq(s.orderLine.storeId, input.storeId), eq(s.orderLine.orderId, order.id))), mode: 'refund', creditEvidence: evidence, pricingSources: evidence.pricingSources });
    const mapping = current?.sourceRefundUnits[input.orderLineId]?.map(unit => unit.originalIndex) ?? state.state.remaining[input.orderLineId]?.map((_, i) => i);
    const refunds = await tx.select().from(s.refund).where(and(eq(s.refund.storeId, input.storeId), eq(s.refund.orderId, order.id), sql`${s.refund.state} <> 'Failed'`));
    const reserved = new Set<number>();
    for (const refund of refunds) {
      if (current?.admittedLegacyRefundIds.includes(refund.id)) continue;
      let frozen: ReturnType<typeof readCreditUnitReturns>;
      try { frozen = readCreditUnitReturns(refund.metadata); } catch { throw new AccountCreditError('allocation', 'Refund reservation requires reconciliation'); }
      if (frozen) {
        if (frozen.redemptionId !== redeem.id) throw new AccountCreditError('allocation', 'Refund reservation redemption differs');
        for (const line of frozen.lines.filter(line => line.orderLineId === input.orderLineId)) {
          for (const index of line.originalIndexes) if (index !== null) reserved.add(index);
        }
      } else {
        const lines = await tx.select({ quantity: s.refundLine.quantity }).from(s.refundLine).where(and(eq(s.refundLine.storeId, input.storeId),
          eq(s.refundLine.refundId, refund.id), eq(s.refundLine.orderLineId, input.orderLineId)));
        if (!lines.length) continue;
        const restored = evidence.history.filter(row => row.refundId === refund.id && row.orderLineId === input.orderLineId);
        // Complete ledger validation above proves these rows. Another line's
        // posting, or a partial quantity on this line, cannot release this hold.
        if (refund.state !== 'Settled' || lines.length !== 1 || restored.length !== 1 || restored[0]!.quantity !== lines[0]!.quantity) {
          throw new AccountCreditError('allocation', 'Unmapped refund reserves returned units');
        }
      }
    }
    originalIndexes = mapping?.filter((index): index is number => index !== null && !state.state.returnedIndexes[input.orderLineId]?.includes(index) && !reserved.has(index)).slice(0, input.quantity);
    if (!originalIndexes || originalIndexes.length !== input.quantity) throw new AccountCreditError('allocation', 'Proven unreserved original return units required');
  }
  const entry = await postRestoration(tx, account, redeem, { ...input, key, refundId: null, originalIndexes });
  if (!entry) throw new AccountCreditError('allocation', 'Manual return requires original funded-unit identity');
  return entry;
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
