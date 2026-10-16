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
  bigint,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { customer, store, ts } from './schema-core.js';
import { order, payment } from './schema-orders.js';

// SELLRIGHT-ISSUES P1: shared rate-limit backend (migration 0078,
// src/auth/rate-limit-backend.ts). Defined here purely so `drizzle-kit
// generate` sees a matching schema object and never proposes dropping a
// table the app actually depends on — every read/write against it goes
// through the raw `pool` in rate-limit-backend.ts, not this export. Global
// infra table: no store_id, no RLS (same EXEMPT posture as session/
// processed_event — see rls-tables.test.ts / assert-force-rls.ts).
export const rateLimitAttempt = pgTable('rate_limit_attempt', {
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  bucket: text().notNull(),
  key: text().notNull(),
  attemptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// Installation-wide key/value settings (migration 0089). Global infra table, no RLS.
export const installationSetting = pgTable('installation_setting', {
  key: text().primaryKey(),
  value: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// SELLRIGHT-ISSUES P1: durable retry for cross-process catalog manifest
// regeneration triggers (migration 0079, manifest/stock-hook.ts). Same
// "defined here for drizzle-kit, queried via raw pool elsewhere" posture as
// rateLimitAttempt above.
export const catalogManifestPending = pgTable('catalog_manifest_pending', {
  storeId: uuid().primaryKey(),
  storeSlug: text().notNull(),
  requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

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
