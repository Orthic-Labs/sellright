import {
  pgTable,
  uuid,
  text,
  bigint,
  boolean,
  timestamp,
  jsonb,
  unique,
} from 'drizzle-orm/pg-core';
import { customer, store, ts } from './schema-core.js';
import { license } from './schema-orders.js';

// ── StoreKit (Apple In-App Purchase) — migration 0066 ───────────────────────
// Ported upstream from RightSites' StoreKit verification lane, genericized:
// every deployment/app-specific fact (bundle id, App Store Connect id,
// product→entitlement mapping, sandbox policy) lives HERE as config — never
// inferred from untrusted client input. A signed JWS's own claims merely
// SELECT which configured app verifies it; the signature check then proves
// them.

/**
 * Per-(store, app) StoreKit configuration. `bundleId` is globally unique: it
 * is the tenant selector for inbound App Store Server Notifications — Apple
 * signs the bundle id into every notification payload, so one bundle id can
 * only ever belong to one store's config.
 *
 * `productMap` maps an Apple productId to the entitlement the purchase
 * materializes as a license:
 *   { "app.example.pro.lifetime": { "tier": "pro", "seats": 0,
 *        "licenseDurationDays": null, "updatesDurationDays": null } }
 * `seats` <= 0 (or absent) = unlimited device activations (Apple-ID-bound
 * purchases are inherently per-account). `licenseDurationDays` bounds the
 * license for non-subscription products; auto-renewable subscriptions instead
 * adopt each signed transaction's expiresDate at link/renew time.
 */
export const storekitApp = pgTable(
  'storekit_app',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    appKey: text().notNull(), // licensing appKey the minted license binds to
    bundleId: text().notNull(),
    // Numeric App Store Connect app id. NULL disables Production verification
    // entirely (Apple's SignedDataVerifier refuses Production without it) —
    // a sandbox/TestFlight-only app leaves this unset and fails closed on
    // real Production transactions rather than silently accepting them.
    appAppleId: bigint({ mode: 'number' }),
    // Environment policy: may this app accept Sandbox-environment purchases.
    // Effective policy is this AND the deployment-wide STOREKIT_ALLOW_SANDBOX.
    allowSandbox: boolean().notNull().default(true),
    productMap: jsonb().notNull().default({}),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [
    unique('storekit_app_store_app').on(t.storeId, t.appKey),
    unique('storekit_app_bundle_id').on(t.bundleId),
  ],
);

/**
 * One row per verified Apple purchase — the durable binding of (environment,
 * originalTransactionId) to the license row it materialized. Replay-safe:
 * the unique constraint on (store_id, environment, original_transaction_id)
 * makes repeat link calls and repeated notifications idempotent, and the
 * environment component keeps Apple's Sandbox/Production transaction-id
 * namespaces from ever colliding (Apple does not promise uniqueness across
 * them).
 */
export const storekitPurchase = pgTable(
  'storekit_purchase',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    storekitAppId: uuid().references(() => storekitApp.id),
    licenseId: uuid().references(() => license.id),
    appKey: text().notNull(),
    // Apple's signed environment claim, captured at verification time —
    // 'Production' | 'Sandbox'. Never client-supplied.
    environment: text().notNull(),
    bundleId: text().notNull(),
    productId: text().notNull(),
    originalTransactionId: text().notNull(),
    transactionId: text(), // latest known transaction id (renewals rotate it)
    customerId: uuid().references(() => customer.id),
    // 'active' | 'revoked' | 'expired'
    status: text().notNull().default('active'),
    expiresAt: timestamp({ withTimezone: true }),
    purchaseDate: timestamp({ withTimezone: true }),
    revocationDate: timestamp({ withTimezone: true }),
    lastNotificationType: text(),
    lastNotificationUuid: text(),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [
    unique('storekit_purchase_unique').on(t.storeId, t.environment, t.originalTransactionId),
  ],
);
