import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { currentDiscount, previewAvailable } from '../account-credit/service.js';
import {
  calculatePromotionStack, canonicalCouponCodes,
  PromotionStackError,
  type PromotionStackTotals, type ResolvedPromotion, type StackCouponStatus, type StackInput,
} from './promotion-stack.js';

export interface ResolvePromotionStackInput extends Omit<StackInput, 'promotions'> {
  storeId: string; orderId?: string; customerId?: string; now?: Date;
  /** Prospective payment quote: only first matched credit may fund a hold. */
  selectedCreditOnly?: boolean;
  mode?: 'quote' | 'payment';
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new Error(`Invalid ${label}`);
  return value;
}

/** Resolve tenant-private eligibility into pure economic facts. This function
 * never reserves/redeems credit or changes usage; checkout owns those effects
 * in this transaction after validating the accepted quote. */
export async function resolvePromotionStack(tx: Tx, input: ResolvePromotionStackInput): Promise<PromotionStackTotals> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid promotion evaluation time');
  let codes = canonicalCouponCodes(input.couponCodes);
  const [store] = await tx.select({ id: s.store.id, currency: s.store.currency }).from(s.store).where(eq(s.store.id, input.storeId)).limit(1);
  if (!store || store.currency !== input.currency) throw new Error('Pricing currency does not match store');
  if (input.orderId) {
    const [order] = await tx.select({ id: s.order.id, currency: s.order.currency }).from(s.order)
      .where(and(eq(s.order.storeId, input.storeId), eq(s.order.id, input.orderId))).limit(1);
    if (!order || order.currency !== input.currency) throw new Error('Pricing order does not match store or currency');
  }
  if (input.customerId) {
    const [customer] = await tx.select({ id: s.customer.id }).from(s.customer)
      .where(and(eq(s.customer.storeId, input.storeId), eq(s.customer.id, input.customerId))).limit(1);
    if (!customer) throw new Error('Pricing customer does not match store');
  }
  // Consistent lock order serializes every payment-candidate promotion before
  // usage counters are read. Quotes remain read-only & lock-free.
  const query = tx.select().from(s.promotion).where(eq(s.promotion.storeId, input.storeId)).orderBy(asc(s.promotion.id));
  const rows = input.mode === 'payment' || input.selectedCreditOnly ? await query.for('update') : await query;
  const credits = await tx.select({ id: s.accountCredit.id, promotionId: s.accountCredit.promotionId, currency: s.accountCredit.currency }).from(s.accountCredit)
    .where(eq(s.accountCredit.storeId, input.storeId));
  const creditByPromotion = new Map(credits.map(account => [account.promotionId, account]));
  // Existing credit lookup trims bearer codes. Preserve generic coupon identity
  // exactly; trim only a uniquely identified credit, never an ordinary code.
  codes = canonicalCouponCodes(codes.map(code => {
    if (rows.some(row => row.type !== 'account_credit' && row.code?.toLowerCase() === code.toLowerCase())) return code;
    const matches = rows.filter(row => row.type === 'account_credit' && row.code?.toLowerCase() === code.trim().toLowerCase());
    return matches.length === 1 ? code.trim() : code;
  }));
  const unavailable = new Map<string, StackCouponStatus>();
  const selectedByCode = new Map<string, typeof rows>();
  for (const code of codes) {
    const matches = rows.filter(row => row.code != null && row.code.toLowerCase() === code.toLowerCase());
    selectedByCode.set(code.toLowerCase(), matches);
    if (matches.length !== 1) unavailable.set(code.toLowerCase(), { code, promotionId: null, applied: false,
      reason: matches.length ? 'Ambiguous coupon code' : 'Coupon unavailable' });
  }
  const candidates = rows.filter(row => row.code == null || selectedByCode.get(row.code.toLowerCase())?.length === 1);
  const firstCredit = codes.map(code => selectedByCode.get(code.toLowerCase())?.[0])
    .find(row => row?.type === 'account_credit' && row.enabled && creditByPromotion.has(row.id));
  if ((input.mode === 'payment' || input.selectedCreditOnly) && input.orderId) {
    const [hold] = await tx.select({ accountId: s.accountCreditTransaction.accountCreditId }).from(s.accountCreditTransaction).where(and(
      eq(s.accountCreditTransaction.storeId, input.storeId), eq(s.accountCreditTransaction.orderId, input.orderId),
      eq(s.accountCreditTransaction.kind, 'RESERVE'), eq(s.accountCreditTransaction.status, 'PENDING'),
    )).limit(1);
    if (hold && (!firstCredit || creditByPromotion.get(firstCredit.id)?.id !== hold.accountId)) {
      throw new PromotionStackError('CREDIT_AMOUNT_CHANGED', 'Credit no longer matches this checkout');
    }
  }
  const resolved: ResolvedPromotion[] = [];
  for (const [sequence, promotion] of candidates.entries()) {
    let reason: string | undefined;
    if (!promotion.enabled) reason = 'Coupon disabled';
    else if (promotion.startsAt && (!Number.isFinite(promotion.startsAt.getTime()) || promotion.startsAt > now)) reason = 'Coupon not started';
    else if (promotion.endsAt && (!Number.isFinite(promotion.endsAt.getTime()) || promotion.endsAt < now)) reason = 'Coupon expired';
    nonnegativeInteger(promotion.usedCount, 'promotion usage');
    let ownUsage = false;
    if (input.orderId) {
      const [prior] = await tx.select({ id: s.promotionUsage.id }).from(s.promotionUsage).where(and(
        eq(s.promotionUsage.storeId, input.storeId), eq(s.promotionUsage.promotionId, promotion.id), eq(s.promotionUsage.orderId, input.orderId),
      )).limit(1);
      ownUsage = !!prior;
    }
    if (promotion.usageLimit != null && nonnegativeInteger(promotion.usageLimit, 'promotion usage limit') <= Math.max(0, promotion.usedCount - (ownUsage ? 1 : 0))) reason = 'Coupon usage limit reached';
    if (promotion.perCustomerUsageLimit != null && input.customerId) {
      const [used] = await tx.select({ n: count() }).from(s.promotionUsage).where(and(
        eq(s.promotionUsage.storeId, input.storeId), eq(s.promotionUsage.promotionId, promotion.id),
        eq(s.promotionUsage.customerId, input.customerId), ...(input.orderId ? [ne(s.promotionUsage.orderId, input.orderId)] : []),
      ));
      if (nonnegativeInteger(promotion.perCustomerUsageLimit, 'customer usage limit') <= (used?.n ?? 0)) reason = 'Customer coupon usage limit reached';
    }
    const account = creditByPromotion.get(promotion.id);
    let credit: ResolvedPromotion['credit'];
    if (promotion.type === 'account_credit') {
      if (!account || account.currency !== input.currency || !promotion.code) reason = 'Credit unavailable';
      else {
        let availableCents = 0;
        if (!reason && (!(input.mode === 'payment' || input.selectedCreditOnly) || promotion.id === firstCredit?.id)) {
          availableCents = input.phase === 'AddingItems' || input.mode === 'payment' || input.selectedCreditOnly
            ? await previewAvailable(tx, { storeId: input.storeId, code: promotion.code, currency: input.currency, orderId: input.orderId, now })
            : await currentDiscount(tx, { storeId: input.storeId, promotionId: promotion.id, currency: input.currency, orderId: input.orderId, phase: input.phase, now });
        }
        nonnegativeInteger(availableCents, 'credit budget');
        credit = { accountId: account.id, availableCents };
        if (availableCents === 0 && !reason) reason = 'Credit unavailable';
      }
    }
    if (reason) {
      if (promotion.code != null) unavailable.set(promotion.code.toLowerCase(), { code: codes.find(code => code.toLowerCase() === promotion.code!.toLowerCase()) ?? promotion.code,
        promotionId: promotion.id, kind: promotion.type, applied: false, appliedAmount: 0, ...(credit ? { availableAmount: credit.availableCents, remainingAmount: credit.availableCents } : {}), reason });
      continue;
    }
    resolved.push({ id: promotion.id, code: promotion.code, kind: promotion.type,
      scope: promotion.type === 'account_credit' ? 'order' : promotion.discountScope,
      value: promotion.value, priority: promotion.priority, sequence: promotion.stackOrder ?? sequence,
      freeShipping: promotion.freeShipping, conditions: promotion.conditions, ...(credit ? { credit } : {}) });
  }
  // Source DB did not guarantee tie order. Imported tied order actions need an
  // explicit captured sequence; UUID order cannot stand in for source evidence.
  for (const promotion of resolved.filter(row => row.scope === 'order')) {
    const peers = resolved.filter(row => row.scope === 'order' && row.priority === promotion.priority);
    if (peers.length > 1 && (peers.some(peer => rows.find(row => row.id === peer.id)?.stackOrder == null) || new Set(peers.map(peer => peer.sequence)).size !== peers.length)) {
      throw new Error('Promotion stack order is unresolved for tied order actions');
    }
  }
  const result = calculatePromotionStack({ ...input, couponCodes: codes, promotions: resolved });
  result.coupons = result.coupons.map(status => unavailable.get(status.code.toLowerCase()) ?? status);
  if ((input.mode === 'payment' || input.selectedCreditOnly) && firstCredit && !result.selectedCredit) {
    throw new PromotionStackError('CREDIT_AMOUNT_CHANGED', 'Credit amount changed; remove & reapply coupon');
  }
  return result;
}
