/**
 * Ops-lane tables (PAR-04 / PAR-07). Defined in their own file because
 * schema-core/orders/content.ts are shared surfaces — these tables are only
 * consumed by the sheerid/dispute modules, so they don't need to ride the
 * shared barrel (schema.ts). Import directly from here.
 *
 * Both tables are FORCE-RLS store-scoped (migrations 0050/0051).
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { customer, store, ts } from './schema-core.js';
import { order, payment } from './schema-orders.js';

// PAR-04: one row per SheerID verification attempt. The customer-facing
// read model stays on `customer` (sheeridVerifications/activeVerifications/
// verificationMetadata — the coupon condition reads those); this table is the
// durable lifecycle + webhook-idempotency record the service recomputes from.
export const sheeridVerification = pgTable('sheerid_verification', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().references(() => customer.id),
  // SheerID's id — NULL until the webhook assigns it (hosted flow). The unique
  // index on (store_id, verification_id) is partial (see migration 0050).
  verificationId: text(),
  programId: text().notNull(),
  category: text(),
  status: text({ enum: ['pending', 'success', 'failed', 'revoked', 'expired'] }).notNull().default('pending'),
  discountPercent: integer(),
  expiresAt: timestamp({ withTimezone: true }),
  details: jsonb(),
  createdAt: ts(),
  updatedAt: ts(),
});

// PAR-07: canonical per-store dispute ledger for every provider (stripe | nmi).
// Unique (store_id, provider, provider_ref) makes provider webhook retries a
// no-op — the operator email is enqueued only on the FIRST insert.
export const dispute = pgTable('dispute', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  provider: text().notNull(), // 'stripe' | 'nmi'
  providerRef: text().notNull(), // Stripe dispute id (dp_…) / NMI chargeback txn id
  paymentId: uuid().references(() => payment.id),
  orderId: uuid().references(() => order.id),
  amount: integer(), // cents when known; NMI reports dollars — parsed to cents at ingest
  currency: text(),
  reason: text(),
  status: text().notNull().default('open'), // open | won | lost | closed — informational
  details: jsonb(),
  notifiedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
  updatedAt: ts(),
});
