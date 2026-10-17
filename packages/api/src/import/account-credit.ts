import { and, eq } from 'drizzle-orm';
import * as s from '../db/schema.js';
import type { ImportContext, ManifestExclusion } from './context.js';
import { digest } from './artifacts.js';
import { parseDate } from './store.js';

export interface SourceCredit {
  id: string; promotionId: string; channelId: string; emailNormalized: string; issuanceKey: string; currency: string;
  initialAmount: number; balance: number; disabled: boolean; sourceRecord: string; sourceCreatedAt: string; sourceUpdatedAt: string;
}
export interface SourceCreditPromotion {
  id: string; code: string | null; enabled: boolean; deletedAt: string | null; startsAt: string | null; endsAt: string | null;
  usageLimit: number | null; perCustomerUsageLimit: number | null; priority: number;
  conditions: string; actions: string; sourceRecord: string;
}
export interface SourceCreditTransaction {
  id: string; accountCreditId: string; kind: string; status: string; amount: number; delta: number; balanceAfter: number | null;
  relatedTransactionId: string | null; idempotencyKey: string; reason: string | null; actor: string | null;
  orderId: string | null; orderCode: string | null; refundId: string | null; orderLineId: string | null; quantity: number | null;
  allocation: string | null; sourceRecord: string; sourceCreatedAt: string; sourceUpdatedAt: string;
}
export interface CreditSourceGraph {
  orders: ReadonlyMap<string, { selected: boolean; hasChannel: boolean }>;
  lines: ReadonlyMap<string, string | null>;
  refunds: ReadonlyMap<string, string | null>;
}
export interface CreditTargetGraph {
  orders: ReadonlyMap<string, { id: string; storeId: string }>;
  lines: ReadonlyMap<string, { id: string; storeId: string; orderId: string }>;
  refunds: ReadonlyMap<string, { id: string; storeId: string; orderId: string }>;
}

export function assertCreditAccountMapping(ctx: Pick<ImportContext, 'storeId' | 'sourceKey' | 'id'>, credits: readonly SourceCredit[],
  accounts: readonly { id: string; storeId: string; sourceKey: string | null; sourceId: string | null }[]) {
  if (credits.some(credit => !accounts.some(account => account.id === ctx.id('account-credit', credit.id) && account.sourceId === credit.id &&
      account.storeId === ctx.storeId && account.sourceKey === ctx.sourceKey))) throw new Error('Imported credit account source/tenant identity mismatch');
}
const signedCents = (value: number) => Number.isSafeInteger(value) && value >= -2147483647 && value <= 2147483647;
const positiveCents = (value: number) => signedCents(value) && value >= 0;
const kinds = new Set<string>(['ISSUE', 'ADJUST', 'DISABLE', 'ENABLE', 'RESERVE', 'RELEASE', 'REDEEM', 'RESTORE']);
const statuses = new Set<string>(['PENDING', 'POSTED', 'VOID']);
const exclusion = (table: string, detail: string, blocking: boolean): ManifestExclusion => ({ type: 'unmappable-source-row', table, detail, count: 1, blocking });

/** Validate monetary conservation without replaying any historical operation. */
export function validateCreditHistory(credits: readonly SourceCredit[], transactions: readonly SourceCreditTransaction[]) {
  const byId = new Map(credits.map(row => [row.id, row]));
  const totals = new Map<string, bigint>();
  for (const tx of transactions) {
    if (!byId.has(tx.accountCreditId)) throw new Error('Credit transaction has no source account');
    if (!kinds.has(tx.kind) || !statuses.has(tx.status) || !positiveCents(tx.amount) || !signedCents(tx.delta) ||
        (tx.balanceAfter != null && !positiveCents(tx.balanceAfter)) || (tx.quantity != null && !positiveCents(tx.quantity)) ||
        typeof tx.idempotencyKey !== 'string' || !tx.idempotencyKey || typeof tx.sourceRecord !== 'string') throw new Error('Invalid source credit transaction');
    totals.set(tx.accountCreditId, (totals.get(tx.accountCreditId) ?? 0n) + BigInt(tx.delta));
  }
  for (const credit of credits) {
    if (!positiveCents(credit.initialAmount) || !positiveCents(credit.balance) || typeof credit.sourceRecord !== 'string') throw new Error('Invalid source credit balance');
    if ((totals.get(credit.id) ?? 0n) !== BigInt(credit.balance)) throw new Error('Source credit balance differs from exact historical deltas');
  }
}

/** Dynamic credit value comes from its balance, never a fixed promotion face value. */
export function buildCreditAccounts(ctx: Pick<ImportContext, 'storeId' | 'sourceKey' | 'channelId' | 'currency' | 'id' | 'promotionSequence'>,
  credits: readonly SourceCredit[], promotions: readonly SourceCreditPromotion[]) {
  const sourcePromotions = new Map(promotions.map(row => [row.id, row]));
  const promoIds = new Set<string>(), codes = new Set<string>(), issuance = new Set<string>();
  const promotionRows: Array<typeof s.promotion.$inferInsert> = [];
  const accountRows: Array<typeof s.accountCredit.$inferInsert> = [];
  const exclusions: ManifestExclusion[] = [];
  for (const credit of credits) {
    if (credit.channelId !== String(ctx.channelId)) throw new Error('Credit account belongs to another source channel');
    const promotion = sourcePromotions.get(credit.promotionId);
    if (!promotion) throw new Error('Credit source promotion is absent');
    const actions = JSON.parse(promotion.actions) as Array<{ code?: string }>;
    const conditions = JSON.parse(promotion.conditions) as Array<{ code?: string }>;
    if (!Array.isArray(actions) || actions.length !== 1 || actions[0]?.code !== 'account_credit_discount' ||
        !Array.isArray(conditions) || conditions.some(condition => condition.code !== 'account_credit_eligible')) throw new Error('Unsupported source credit promotion semantics');
    if (!promotion.code || typeof credit.emailNormalized !== 'string' || typeof credit.issuanceKey !== 'string' || !credit.issuanceKey ||
        typeof credit.currency !== 'string' || typeof credit.disabled !== 'boolean' || typeof promotion.enabled !== 'boolean' ||
        typeof credit.sourceRecord !== 'string' || typeof promotion.sourceRecord !== 'string' ||
        !positiveCents(credit.initialAmount) || !positiveCents(credit.balance) || !signedCents(promotion.priority) ||
        (promotion.usageLimit != null && !positiveCents(promotion.usageLimit)) ||
        (promotion.perCustomerUsageLimit != null && !positiveCents(promotion.perCustomerUsageLimit))) throw new Error('Invalid source credit account or promotion');
    const code = promotion.code.toLowerCase();
    if (promoIds.has(promotion.id) || codes.has(code) || issuance.has(credit.issuanceKey)) throw new Error('Conflicting source credit identity');
    promoIds.add(promotion.id); codes.add(code); issuance.add(credit.issuanceKey);
    const active = promotion.enabled && promotion.deletedAt == null;
    const sequence = ctx.promotionSequence;
    if (sequence && (sequence.sourceKey !== ctx.sourceKey || sequence.channelId !== ctx.channelId)) throw new Error('Credit promotion sequence source mismatch');
    const captured = sequence?.entries.find(entry => entry.sourceId === promotion.id);
    if (active && captured && captured.sourceRecord !== promotion.sourceRecord) throw new Error('Credit promotion differs from captured source sequence');
    const stackOrder = active ? captured?.stackOrder ?? null : null;
    if (active && stackOrder == null) exclusions.push(exclusion('promotion', 'Active credit promotion has no qualified captured stack rank', true));
    promotionRows.push({ id: ctx.id('promotion', promotion.id), storeId: ctx.storeId, code: promotion.code,
      type: 'account_credit', value: 0, discountScope: 'order', stackOrder, conditions: [], startsAt: parseDate(promotion.startsAt), endsAt: parseDate(promotion.endsAt),
      usageLimit: promotion.usageLimit, perCustomerUsageLimit: promotion.perCustomerUsageLimit, priority: promotion.priority,
      enabled: promotion.enabled && promotion.deletedAt == null });
    accountRows.push({ id: ctx.id('account-credit', credit.id), storeId: ctx.storeId, promotionId: ctx.id('promotion', promotion.id),
      currency: credit.currency, emailNormalized: credit.emailNormalized, issuanceKey: credit.issuanceKey,
      initialAmount: credit.initialAmount, balance: credit.balance, disabled: credit.disabled,
      sourceKey: ctx.sourceKey, sourceId: credit.id, sourceRecord: credit.sourceRecord, sourcePromotionRecord: promotion.sourceRecord,
      sourceDigest: digest({ format: 'retained-pg-jsonb-text-v1', account: credit.sourceRecord, promotion: promotion.sourceRecord }),
      sourceCreatedAt: credit.sourceCreatedAt, sourceUpdatedAt: credit.sourceUpdatedAt,
      createdAt: parseDate(credit.sourceCreatedAt) ?? undefined, updatedAt: parseDate(credit.sourceUpdatedAt) ?? undefined });
    if (credit.currency !== ctx.currency) exclusions.push(exclusion('account_credit', 'Retained monetary credit uses another currency; redemption currency guard applies', true));
  }
  return { promotionRows, accountRows, exclusions };
}

/** Opaque allocation remains unchanged; only safe integer cent arrays enter operational JSON. */
export function parseCreditAllocation(raw: string | null): Record<string, number[]> | null {
  if (raw == null) return null;
  const value: unknown = JSON.parse(raw);
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source credit allocation');
  for (const [lineId, cents] of Object.entries(value)) {
    if (!/^\d+$/.test(lineId) || !Array.isArray(cents) || cents.some(c => typeof c !== 'number' || !positiveCents(c))) throw new Error('Invalid source credit allocation');
  }
  return value as Record<string, number[]>;
}

export function buildCreditTransactions(ctx: Pick<ImportContext, 'storeId' | 'sourceKey' | 'id'>,
  credits: readonly SourceCredit[], transactions: readonly SourceCreditTransaction[], source: CreditSourceGraph, target: CreditTargetGraph) {
  validateCreditHistory(credits, transactions);
  const creditsById = new Map(credits.map(row => [row.id, row]));
  const txById = new Map(transactions.map(row => [row.id, row]));
  const exclusions: ManifestExclusion[] = [];
  const rows: Array<typeof s.accountCreditTransaction.$inferInsert> = [];
  for (const credit of credits) {
    const held = transactions.filter(tx => tx.accountCreditId === credit.id && tx.kind === 'RESERVE' && tx.status === 'PENDING')
      .reduce((sum, tx) => sum + BigInt(tx.amount), 0n);
    if (held > BigInt(credit.balance)) exclusions.push(exclusion('account_credit', 'pending_holds_exceed_balance: exact balance & holds retained; reconciliation required', true));
  }
  for (const tx of transactions) {
    const credit = creditsById.get(tx.accountCreditId)!;
    let blocked = false;
    const classify = (detail: string, blocking: boolean) => { exclusions.push(exclusion('account_credit_transaction', detail, blocking)); if (blocking) blocked = true; };
    const sourceOrder = tx.orderId == null ? undefined : source.orders.get(tx.orderId);
    const order = sourceOrder?.selected && tx.orderId != null ? target.orders.get(ctx.id('order', tx.orderId)) : undefined;
    if (order && order.storeId !== ctx.storeId) throw new Error('Cross-store credit order link refused');
    if (tx.orderId != null && !sourceOrder) classify('source_order_absent: original credit order reference retained privately', false);
    else if (sourceOrder && !sourceOrder.selected) classify(sourceOrder.hasChannel ? 'other_channel_order: original credit order reference retained privately' : 'unresolved_order_channel: semantic projection blocked', !sourceOrder.hasChannel);
    else if (sourceOrder && !order) classify('target_order_unmapped: original credit order reference retained privately', tx.kind === 'REDEEM' || tx.kind === 'RESTORE');
    if (tx.kind === 'RESERVE' && tx.status === 'PENDING' && !order) classify('pending_order_unresolved: original hold retained; reconciliation required', true);
    const mapLine = (sourceLineId: string) => {
      const parent = source.lines.get(sourceLineId);
      if (parent == null) { classify('source_allocation_line_absent: original reference retained; operational projection blocked', true); return null; }
      if (tx.orderId == null || parent !== tx.orderId || !source.orders.get(parent)?.selected) { classify('allocation_line_wrong_order_or_channel: operational projection blocked', true); return null; }
      const line = target.lines.get(ctx.id('order-line', sourceLineId));
      if (!line || !order) { classify('target_allocation_line_unmapped: operational projection blocked', true); return null; }
      if (line.storeId !== ctx.storeId || line.orderId !== order.id) throw new Error('Cross-store or wrong-order credit line refused');
      return line.id;
    };
    const lineId = tx.orderLineId == null ? null : mapLine(tx.orderLineId);
    let refundId: string | null = null;
    if (tx.refundId != null) {
      const sourceRefundOrder = source.refunds.get(tx.refundId);
      if (sourceRefundOrder == null || tx.orderId == null || sourceRefundOrder !== tx.orderId) classify('refund_order_unresolved: original reference retained; operational projection blocked', true);
      else {
        const refund = order ? target.refunds.get(ctx.id('refund', tx.refundId)) : undefined;
        if (refund && (refund.storeId !== ctx.storeId || refund.orderId !== order!.id)) throw new Error('Cross-store or wrong-order credit refund refused');
        refundId = refund?.id ?? null;
        if (!refund) classify('target_refund_unmapped: original reference retained; operational projection blocked', true);
      }
    }
    const allocation = parseCreditAllocation(tx.allocation);
    let operationalAllocation: Record<string, number[]> | null = allocation == null ? null : {};
    if (allocation != null) {
      let total = 0n;
      for (const [sourceLineId, cents] of Object.entries(allocation)) {
        total += cents.reduce((sum, value) => sum + BigInt(value), 0n);
        const targetLineId = mapLine(sourceLineId);
        if (targetLineId) operationalAllocation![targetLineId] = cents;
      }
      if (tx.kind === 'REDEEM' && total !== BigInt(tx.amount)) throw new Error('Source credit allocation differs from redemption amount');
    } else if (tx.kind === 'REDEEM') classify('redemption_allocation_absent: operational restoration projection blocked', true);
    if (blocked) operationalAllocation = null;
    const related = tx.relatedTransactionId == null ? undefined : txById.get(tx.relatedTransactionId);
    if (tx.relatedTransactionId != null && (!related || related.accountCreditId !== credit.id)) throw new Error('Related source credit transaction is absent or belongs to another account');
    rows.push({ id: ctx.id('account-credit-transaction', tx.id), storeId: ctx.storeId,
      accountCreditId: ctx.id('account-credit', credit.id), kind: tx.kind as s.AccountCreditKind, status: tx.status as s.AccountCreditStatus,
      amount: tx.amount, delta: tx.delta, balanceAfter: tx.balanceAfter, relatedTransactionId: related ? ctx.id('account-credit-transaction', related.id) : null,
      idempotencyKey: tx.idempotencyKey, reason: tx.reason, actor: tx.actor, orderId: blocked ? null : order?.id ?? null,
      orderCode: tx.orderCode, refundId: blocked ? null : refundId, orderLineId: blocked ? null : lineId,
      sourceOrderId: tx.orderId, sourceRefundId: tx.refundId, sourceOrderLineId: tx.orderLineId, quantity: tx.quantity,
      allocation: tx.allocation, operationalAllocation, sourceKey: ctx.sourceKey, sourceId: tx.id,
      sourceRecord: tx.sourceRecord, sourceDigest: digest({ format: 'retained-pg-jsonb-text-v1', transaction: tx.sourceRecord }),
      sourceCreatedAt: tx.sourceCreatedAt, sourceUpdatedAt: tx.sourceUpdatedAt,
      createdAt: parseDate(tx.sourceCreatedAt) ?? undefined, updatedAt: parseDate(tx.sourceUpdatedAt) ?? undefined });
  }
  return { rows, exclusions };
}

async function readCredits(ctx: ImportContext) {
  const credits = await ctx.q(`SELECT a.id::text AS id, a."promotionId"::text AS "promotionId", a."channelId"::text AS "channelId",
    a."emailNormalized", a."issuanceKey", a."currencyCode" AS currency, a."initialAmount", a.balance, a.disabled,
    a."createdAt"::text AS "sourceCreatedAt", a."updatedAt"::text AS "sourceUpdatedAt", to_jsonb(a)::text AS "sourceRecord"
    FROM account_credit a ORDER BY a.id`) as SourceCredit[];
  const transactions = await ctx.q(`SELECT t.id::text AS id, t."accountCreditId"::text AS "accountCreditId", t.kind, t.status,
    t.amount, t.delta, t."balanceAfter", t."relatedTransactionId"::text AS "relatedTransactionId", t."idempotencyKey", t.reason, t.actor,
    t."orderId"::text AS "orderId", t."orderCode", t."refundId"::text AS "refundId", t."orderLineId"::text AS "orderLineId", t.quantity,
    t.allocation::text AS allocation, t."createdAt"::text AS "sourceCreatedAt", t."updatedAt"::text AS "sourceUpdatedAt",
    to_jsonb(t)::text AS "sourceRecord" FROM account_credit_transaction t ORDER BY t.id`) as SourceCreditTransaction[];
  return { credits, transactions };
}

/** Run before orders so historical coupon attribution resolves to its real credit promotion. */
export async function importAccountCredits(ctx: ImportContext) {
  if (!ctx.sourceColumns.has('account_credit')) {
    ctx.exclusions.push({ type: 'source-extension-absent', table: 'account_credit', detail: 'Source has no monetary account-credit plugin tables' });
    return;
  }
  const { credits, transactions } = await readCredits(ctx);
  validateCreditHistory(credits, transactions);
  const promotions = await ctx.q(`SELECT p.id::text AS id, p."couponCode" AS code, p.enabled, p."deletedAt"::text AS "deletedAt",
    p."startsAt"::text AS "startsAt", p."endsAt"::text AS "endsAt", p."usageLimit", p."perCustomerUsageLimit", p."priorityScore" AS priority,
    p.conditions, p.actions, to_jsonb(p)::text AS "sourceRecord" FROM promotion p
    WHERE p.id IN (SELECT "promotionId" FROM account_credit) ORDER BY p.id`) as SourceCreditPromotion[];
  const result = buildCreditAccounts(ctx, credits, promotions);
  const existing = await ctx.tx.select().from(s.promotion).where(eq(s.promotion.storeId, ctx.storeId));
  if (result.promotionRows.some(row => existing.some(other => other.id !== row.id && other.code?.toLowerCase() === row.code?.toLowerCase()))) throw new Error('Credit promotion code conflicts with another imported promotion');
  if (result.promotionRows.some(row => existing.some(other => other.id === row.id && other.type !== 'account_credit'))) throw new Error('Credit promotion identity conflicts with another promotion type');
  for (const row of result.promotionRows) {
    const written = await ctx.tx.insert(s.promotion).values(row).onConflictDoUpdate({ target: s.promotion.id, set: row,
      setWhere: eq(s.promotion.storeId, ctx.storeId) }).returning({ id: s.promotion.id });
    if (written.length !== 1) throw new Error('Cross-store credit promotion identity refused');
  }
  for (const row of result.accountRows) await ctx.tx.insert(s.accountCredit).values(row).onConflictDoUpdate({
    target: [s.accountCredit.storeId, s.accountCredit.sourceKey, s.accountCredit.sourceId], set: row });
  ctx.exclusions.push(...result.exclusions);
}

/** Direct historical insert; no ISSUE/RESERVE/REDEEM/RESTORE service runs. */
export async function importAccountCreditTransactions(ctx: ImportContext) {
  if (!ctx.sourceColumns.has('account_credit')) return;
  const { credits, transactions } = await readCredits(ctx);
  const sourceOrders = await ctx.q(`SELECT o.id::text AS id,
    EXISTS(SELECT 1 FROM order_channels_channel c WHERE c."orderId"=o.id AND c."channelId"=$1) AS selected,
    EXISTS(SELECT 1 FROM order_channels_channel c WHERE c."orderId"=o.id) AS "hasChannel" FROM "order" o ORDER BY o.id`, [ctx.channelId]);
  const sourceLines = await ctx.q('SELECT id::text AS id, "orderId"::text AS "orderId" FROM order_line ORDER BY id');
  const sourceRefunds = await ctx.q('SELECT r.id::text AS id, p."orderId"::text AS "orderId" FROM refund r LEFT JOIN payment p ON p.id=r."paymentId" ORDER BY r.id');
  const orders = await ctx.tx.select().from(s.order).where(eq(s.order.storeId, ctx.storeId));
  const lines = await ctx.tx.select().from(s.orderLine).where(eq(s.orderLine.storeId, ctx.storeId));
  const refunds = await ctx.tx.select().from(s.refund).where(eq(s.refund.storeId, ctx.storeId));
  const accounts = await ctx.tx.select().from(s.accountCredit).where(and(eq(s.accountCredit.storeId, ctx.storeId), eq(s.accountCredit.sourceKey, ctx.sourceKey)));
  assertCreditAccountMapping(ctx, credits, accounts);
  const result = buildCreditTransactions(ctx, credits, transactions,
    { orders: new Map(sourceOrders.map(row => [row.id, { selected: row.selected, hasChannel: row.hasChannel }])),
      lines: new Map(sourceLines.map(row => [row.id, row.orderId])), refunds: new Map(sourceRefunds.map(row => [row.id, row.orderId])) },
    { orders: new Map(orders.map(row => [row.id, row])), lines: new Map(lines.map(row => [row.id, row])), refunds: new Map(refunds.map(row => [row.id, row])) });
  // Null links first permits arbitrary source PK ordering, including forward references.
  for (const row of result.rows) await ctx.tx.insert(s.accountCreditTransaction).values({ ...row, relatedTransactionId: null }).onConflictDoUpdate({
    target: [s.accountCreditTransaction.storeId, s.accountCreditTransaction.sourceKey, s.accountCreditTransaction.sourceId], set: { ...row, relatedTransactionId: null } });
  for (const row of result.rows) if (row.relatedTransactionId) await ctx.tx.update(s.accountCreditTransaction).set({ relatedTransactionId: row.relatedTransactionId })
    .where(and(eq(s.accountCreditTransaction.storeId, ctx.storeId), eq(s.accountCreditTransaction.sourceKey, ctx.sourceKey), eq(s.accountCreditTransaction.id, row.id!)));
  ctx.exclusions.push(...result.exclusions);
}
