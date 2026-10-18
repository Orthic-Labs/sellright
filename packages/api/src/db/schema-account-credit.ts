/** Monetary coupon credit. Imported balances are authoritative snapshots, never replayed entries. */
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { promotion, store, ts } from './schema-core.js';
import { order, orderLine, refund } from './schema-orders.js';

export const accountCreditKinds = ['ISSUE', 'ADJUST', 'DISABLE', 'ENABLE', 'RESERVE', 'RELEASE', 'REDEEM', 'RESTORE'] as const;
export type AccountCreditKind = typeof accountCreditKinds[number];
export type AccountCreditStatus = 'PENDING' | 'POSTED' | 'VOID';
export type AccountCreditAllocation = Record<string, number[]>;

export const accountCredit = pgTable('account_credit', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  promotionId: uuid().notNull().references(() => promotion.id),
  currency: text().notNull(),
  // Private issuance metadata: never an eligibility or ownership gate.
  emailNormalized: text().notNull(),
  issuanceKey: text().notNull(),
  initialAmount: integer().notNull(),
  balance: integer().notNull(),
  disabled: boolean().notNull().default(false),
  sourceKey: text(), sourceId: text(), sourceDigest: text(), sourceRecord: text(),
  sourcePromotionRecord: text(), sourceCreatedAt: text(), sourceUpdatedAt: text(),
  createdAt: ts(), updatedAt: ts(),
}, t => [
  unique('account_credit_store_promotion').on(t.storeId, t.promotionId),
  unique('account_credit_store_issuance').on(t.storeId, t.issuanceKey),
  unique('account_credit_source_identity').on(t.storeId, t.sourceKey, t.sourceId),
  check('account_credit_amounts', sql`${t.initialAmount} >= 0 AND ${t.balance} >= 0`),
]);

export const accountCreditTransaction = pgTable('account_credit_transaction', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  accountCreditId: uuid().notNull().references(() => accountCredit.id),
  kind: text().$type<AccountCreditKind>().notNull(),
  status: text().$type<AccountCreditStatus>().notNull(),
  amount: integer().notNull(), delta: integer().notNull(), balanceAfter: integer(),
  relatedTransactionId: uuid().references((): AnyPgColumn => accountCreditTransaction.id),
  idempotencyKey: text().notNull(), reason: text(), actor: text(),
  orderId: uuid().references(() => order.id, { onDelete: 'set null' }),
  orderCode: text(),
  refundId: uuid().references(() => refund.id, { onDelete: 'set null' }),
  orderLineId: uuid().references(() => orderLine.id, { onDelete: 'set null' }),
  sourceOrderId: text(), sourceRefundId: text(), sourceOrderLineId: text(),
  quantity: integer(),
  // Original source allocation is retained byte-for-byte. Only proven native UUID
  // projections belong in operationalAllocation; restoration never guesses a map.
  allocation: text(), operationalAllocation: jsonb().$type<AccountCreditAllocation>(),
  sourceKey: text(), sourceId: text(), sourceDigest: text(), sourceRecord: text(),
  sourceCreatedAt: text(), sourceUpdatedAt: text(),
  createdAt: ts(), updatedAt: ts(),
}, t => [
  unique('account_credit_transaction_store_key').on(t.storeId, t.idempotencyKey),
  unique('account_credit_transaction_source_identity').on(t.storeId, t.sourceKey, t.sourceId),
  uniqueIndex('account_credit_pending_order').on(t.storeId, t.orderId)
    .where(sql`${t.kind} = 'RESERVE' AND ${t.status} = 'PENDING'`),
  index('account_credit_transaction_account').on(t.storeId, t.accountCreditId),
  index('account_credit_transaction_order').on(t.storeId, t.orderId),
  check('account_credit_transaction_kind', sql`${t.kind} IN ('ISSUE','ADJUST','DISABLE','ENABLE','RESERVE','RELEASE','REDEEM','RESTORE')`),
  check('account_credit_transaction_status', sql`${t.status} IN ('PENDING','POSTED','VOID')`),
  check('account_credit_transaction_amounts', sql`${t.amount} >= 0 AND ${t.delta} >= -2147483647 AND (${t.balanceAfter} IS NULL OR ${t.balanceAfter} >= 0) AND (${t.quantity} IS NULL OR ${t.quantity} >= 0)`),
  check('account_credit_transaction_pending', sql`${t.status} <> 'PENDING' OR (${t.kind} = 'RESERVE' AND ${t.amount} > 0)`),
]);
