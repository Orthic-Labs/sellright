import { and, asc, count, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
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
  /** Normalised contact email: identifies a guest (no customer row) for the per-customer limit, as the previous platform counted by email. */
  customerEmail?: string;
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
  // P3a B1/C4: only the commit path (mode 'payment') locks, and it locks only candidate rows: automatic promotions
  // (no code) plus rows whose code can match a requested code. Quotes — including the public checkout-intent quote
  // (selectedCreditOnly) — take no promotion row locks; checkout re-resolves under locks before any usage write.
  // Rows are locked in id order (stable across writers). The SQL filter is a superset of the JS case-insensitive match
  // below: ASCII codes casefold identically in SQL lower() and JS; any non-ASCII stored code is always loaded and a
  // non-ASCII request code disables the filter, so collation-dependent lower() can never drop a JS match.
  const locking = input.mode === 'payment';
  const asciiOnly = codes.every(code => /^[\x00-\x7F]*$/.test(code));
  const lowered = [...new Set(codes.flatMap(code => [code.toLowerCase(), code.trim().toLowerCase()]))];
  const codeFilter = !asciiOnly ? undefined : lowered.length
    ? or(isNull(s.promotion.code), inArray(sql`lower(${s.promotion.code})`, lowered), sql`${s.promotion.code} ~ '[^\x01-\x7F]'`)
    : or(isNull(s.promotion.code), sql`${s.promotion.code} ~ '[^\x01-\x7F]'`);
  const query = tx.select().from(s.promotion).where(and(eq(s.promotion.storeId, input.storeId), codeFilter)).orderBy(asc(s.promotion.id));
  const rows = locking ? await query.for('update') : await query;
  const creditPromotionIds = rows.filter(row => row.type === 'account_credit').map(row => row.id);
  const credits = creditPromotionIds.length
    ? await tx.select({ id: s.accountCredit.id, promotionId: s.accountCredit.promotionId, currency: s.accountCredit.currency }).from(s.accountCredit)
      .where(and(eq(s.accountCredit.storeId, input.storeId), inArray(s.accountCredit.promotionId, creditPromotionIds)))
    : [];
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
  // C4: usage facts for every candidate in at most three set queries (no per-promotion N+1). Same predicates as the
  // former per-row queries, grouped by promotion_id; read under the same promotion locks in payment mode.
  const candidateIds = candidates.map(row => row.id);
  const ownUsageIds = new Set<string>();
  if (input.orderId && candidateIds.length) {
    const prior = await tx.selectDistinct({ promotionId: s.promotionUsage.promotionId }).from(s.promotionUsage).where(and(
      eq(s.promotionUsage.storeId, input.storeId), inArray(s.promotionUsage.promotionId, candidateIds), eq(s.promotionUsage.orderId, input.orderId)));
    for (const row of prior) ownUsageIds.add(row.promotionId);
  }
  const releasedIds = candidates.filter(row => row.usageLimit != null && row.usedCount > 0).map(row => row.id);
  const releasedByPromotion = new Map<string, number>();
  if (releasedIds.length) {
    const cancelled = await tx.select({ promotionId: s.promotionUsage.promotionId, n: count() }).from(s.promotionUsage)
      .innerJoin(s.order, eq(s.order.id, s.promotionUsage.orderId)).where(and(
        eq(s.promotionUsage.storeId, input.storeId), inArray(s.promotionUsage.promotionId, releasedIds), eq(s.order.state, 'Cancelled'),
        ...(input.orderId ? [ne(s.promotionUsage.orderId, input.orderId)] : []),
      )).groupBy(s.promotionUsage.promotionId);
    for (const row of cancelled) releasedByPromotion.set(row.promotionId, row.n);
  }
  // Registered customer: count by customerId. Guest: count by email (order contact or linked customer), not skipped.
  const email = input.customerEmail?.trim().toLowerCase();
  const who = input.customerId ? eq(s.promotionUsage.customerId, input.customerId)
    : email ? or(eq(sql`lower(${s.customer.email})`, email), eq(sql`lower(${s.order.metadata}->'contact'->>'email')`, email)) : undefined;
  const perCustomerIds = candidates.filter(row => row.perCustomerUsageLimit != null && row.perCustomerUsageLimit !== 0).map(row => row.id);
  const customerUsedByPromotion = new Map<string, number>();
  if (who && perCustomerIds.length) {
    const used = await tx.select({ promotionId: s.promotionUsage.promotionId, n: count() }).from(s.promotionUsage)
      .innerJoin(s.order, eq(s.order.id, s.promotionUsage.orderId))
      .leftJoin(s.customer, eq(s.customer.id, s.promotionUsage.customerId)).where(and(
        eq(s.promotionUsage.storeId, input.storeId), inArray(s.promotionUsage.promotionId, perCustomerIds), who, ne(s.order.state, 'Cancelled'),
        ...(input.orderId ? [ne(s.promotionUsage.orderId, input.orderId)] : []),
      )).groupBy(s.promotionUsage.promotionId);
    for (const row of used) customerUsedByPromotion.set(row.promotionId, row.n);
  }
  const resolved: ResolvedPromotion[] = [];
  for (const [sequence, promotion] of candidates.entries()) {
    let reason: string | undefined;
    if (!promotion.enabled) reason = 'Coupon disabled';
    else if (promotion.startsAt && (!Number.isFinite(promotion.startsAt.getTime()) || promotion.startsAt > now)) reason = 'Coupon not started';
    else if (promotion.endsAt && (!Number.isFinite(promotion.endsAt.getTime()) || promotion.endsAt < now)) reason = 'Coupon expired';
    nonnegativeInteger(promotion.usedCount, 'promotion usage');
    const ownUsage = ownUsageIds.has(promotion.id);
    // the previous platform (coupon-validation.service.ts checkUsageLimits): a limit of 0 means blocked, not unlimited; usage on a
    // Cancelled order does not count. promotion_usage rows of Cancelled orders are discounted from used_count here (under
    // the same promotion FOR UPDATE as the usage insert), so every cancel path frees its use without a counter write.
    if (promotion.usageLimit != null) {
      const limit = nonnegativeInteger(promotion.usageLimit, 'promotion usage limit');
      const released = promotion.usedCount > 0 ? releasedByPromotion.get(promotion.id) ?? 0 : 0;
      if (limit <= Math.max(0, promotion.usedCount - released - (ownUsage ? 1 : 0))) reason = 'Coupon usage limit reached';
    }
    if (promotion.perCustomerUsageLimit != null) {
      const perCustomer = nonnegativeInteger(promotion.perCustomerUsageLimit, 'customer usage limit');
      if (perCustomer === 0) reason = 'Customer coupon usage limit reached';
      else if (who && perCustomer <= (customerUsedByPromotion.get(promotion.id) ?? 0)) reason = 'Customer coupon usage limit reached';
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
