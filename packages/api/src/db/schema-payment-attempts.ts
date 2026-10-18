import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, jsonb, timestamp, unique, check } from 'drizzle-orm/pg-core';
import { store, ts } from './schema-core.js';
import { order, payment } from './schema-orders.js';

/** Persist before external I/O; unresolved attempts survive crashes and reserve money. */
export const paymentAttempt = pgTable('payment_attempt', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  orderId: uuid().notNull().references(() => order.id),
  paymentId: uuid().references(() => payment.id),
  operation: text().notNull(),
  method: text().notNull(),
  accountId: text().notNull(),
  mode: text().notNull(),
  amount: integer().notNull(),
  currency: text().notNull(),
  idempotencyKey: text().notNull(),
  fingerprint: text().notNull(),
  status: text().notNull().default('processing'),
  providerRef: text(),
  context: jsonb(),
  result: jsonb(),
  // 0088 (de-fork 2.9): the provider's own status string and when we last
  // SUCCESSFULLY retrieved it. Advanced only by successful provider retrieval
  // (payments/provider-observation.ts) — never by webhook payloads or a failed fetch.
  providerStatus: text(),
  providerObservedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
  updatedAt: ts(),
}, (t) => [
  unique('payment_attempt_store_key').on(t.storeId, t.idempotencyKey),
  // Gateway attempts always move positive cash. Only the server-proven credit
  // merchandise return may reserve zero cash against its original payment.
  check('payment_attempt_amount_check', sql`${t.amount} > 0 OR (
    ${t.amount} = 0 AND ${t.operation} = 'refund' AND ${t.method} = 'credit_merchandise' AND ${t.mode} = 'internal'
    AND ${t.paymentId} IS NOT NULL AND ${t.providerRef} IS NULL
    AND COALESCE(${t.context}->>'authority' = 'credit_merchandise', false)
    AND COALESCE(${t.context}->>'redemptionId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
  )`),
  check('payment_attempt_mode_check', sql`(${t.mode} IN ('test','live') AND ${t.method} <> 'credit_merchandise') OR
    (${t.mode} = 'internal' AND ${t.method} = 'credit_merchandise' AND ${t.operation} = 'refund' AND ${t.amount} = 0)`),
]);

/** Authenticated inbound events survive retries, reordering and API restarts. */
export const gatewayEvent = pgTable('gateway_event', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  method: text().notNull(),
  accountId: text().notNull(),
  mode: text().notNull(),
  eventId: text().notNull(),
  eventType: text().notNull(),
  providerRef: text().notNull(),
  status: text().notNull().default('pending'),
  attempts: integer().notNull().default(0),
  details: jsonb(),
  lastError: text(),
  createdAt: ts(),
  updatedAt: ts(),
}, t => [unique('gateway_event_identity').on(t.storeId, t.method, t.accountId, t.mode, t.eventId)]);
