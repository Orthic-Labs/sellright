import { pgTable, uuid, text, integer, jsonb, unique } from 'drizzle-orm/pg-core';
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
  createdAt: ts(),
  updatedAt: ts(),
}, (t) => [unique('payment_attempt_store_key').on(t.storeId, t.idempotencyKey)]);

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
