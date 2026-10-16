import { type AnyPgColumn, pgTable, uuid, text, integer, jsonb, timestamp, unique, foreignKey } from 'drizzle-orm/pg-core';
import { store, ts, paymentState } from './schema-core.js';

/**
 * Settlement operations (migration 0087; docs/PENDING-EFFECTS.md). One row per
 * settlement FACT, keyed by the provider / business identity, so a replay of the
 * same fact — through any code path — is a no-op. An invoice's classification
 * and authorized effect set are frozen here on first observation.
 */
export const settlementOperation = pgTable('settlement_operation', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id, { onDelete: 'cascade' }),
  operationKind: text().notNull(),
  operationId: text().notNull(),
  classification: text(), // first_cycle | renewal | adjustment | unresolved (stripe_invoice_paid only)
  authorizedEffects: text().array().notNull().default([]),
  disposition: text(),
  paymentId: uuid(),
  orderId: uuid(),
  licenseId: uuid(),
  invoicePaymentId: uuid(),
  paymentIntent: text(),
  providerAccount: text(),
  providerMode: text(),
  targetKind: text(), // operator_resolution only
  targetId: text(),
  actor: text(),
  reason: text(),
  snapshot: jsonb(), // order_purge only: the purged order's payments
  createdAt: ts(),
}, (t) => [unique('settlement_operation_identity').on(t.storeId, t.operationKind, t.operationId)]);

/** The effects an operation authorizes; executed exactly once (see payments/settlement/effects.ts). */
export const orderPendingEffect = pgTable('order_pending_effect', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id, { onDelete: 'cascade' }),
  operationKind: text().notNull(),
  operationId: text().notNull(),
  effectKind: text().notNull(),
  payloadVersion: integer().notNull().default(1),
  payload: jsonb().notNull().default({}),
  status: text().notNull().default('pending'), // pending | processing | done | terminal
  claimToken: uuid(),
  claimedAt: timestamp({ withTimezone: true }),
  attempts: integer().notNull().default(0),
  nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  firstFailedAt: timestamp({ withTimezone: true }),
  lastError: text(),
  result: jsonb(),
  resolution: jsonb(), // NULL for every held outcome; set at insert only where a terminal row is final by design
  resolvedBy: uuid().references((): AnyPgColumn => settlementOperation.id, { onDelete: 'set null' }), // settlement_operation.id of the operator resolution that handled a terminal row
  createdAt: ts(),
  updatedAt: ts(),
}, (t) => [
  unique('order_pending_effect_identity').on(t.storeId, t.operationKind, t.operationId, t.effectKind),
  foreignKey({ columns: [t.storeId, t.operationKind, t.operationId], foreignColumns: [settlementOperation.storeId, settlementOperation.operationKind, settlementOperation.operationId], name: 'order_pending_effect_operation_fk' }).onDelete('cascade'),
]);

/** External-effect receipt: written with `done` (provider idempotency key = effect id). */
export const appliedOperationReceipt = pgTable('applied_operation_receipt', {
  effectId: uuid().primaryKey().references(() => orderPendingEffect.id, { onDelete: 'cascade' }),
  storeId: uuid().notNull().references(() => store.id, { onDelete: 'cascade' }),
  providerRef: text().notNull(),
  createdAt: ts(),
});

/** Money record for a subscription invoice with no backing order (payment.order_id is NOT NULL). */
export const subscriptionInvoicePayment = pgTable('subscription_invoice_payment', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id, { onDelete: 'cascade' }),
  orderId: uuid(), // informational; no FK
  stripeAccountId: text().notNull(),
  mode: text().notNull(), // test | live
  stripeSubscriptionId: text().notNull(),
  invoiceId: text().notNull(),
  providerRef: text().notNull(),
  amount: integer().notNull(),
  currency: text(),
  state: paymentState().notNull().default('Settled'),
  paidAt: timestamp({ withTimezone: true }),
  billingReason: text(),
  origin: text().notNull(), // live | historical_backfill
  disposition: text(),
  frontierId: uuid(),
  metadata: jsonb(),
  createdAt: ts(),
});
