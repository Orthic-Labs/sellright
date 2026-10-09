import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  unique,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  adminUser,
  customer,
  fulfillmentState,
  fulfillmentType,
  licenseStatus,
  orderState,
  paymentState,
  productVariant,
  promotion,
  refundState,
  returnStatus,
  store,
  subscriptionStatus,
  ts,
} from './schema-core.js';

// ── orders & money ──────────────────────────────────────────────────────────
export const order = pgTable(
  'order',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    code: text().notNull(),
    customerId: uuid().references(() => customer.id),
    state: orderState().notNull().default('PendingPayment'),
    currency: text().notNull().default('USD'),
    subtotal: integer().notNull().default(0),
    discountTotal: integer().notNull().default(0),
    shippingTotal: integer().notNull().default(0),
    taxTotal: integer().notNull().default(0),
    grandTotal: integer().notNull().default(0),
    isPreOrder: boolean().notNull().default(false),
    // One-click install (plan §1.5): true for any order placed while the
    // store was still unpublished (private preview). Excluded from reports/
    // dashboard KPIs — see PAID_STATES/isDemo callers in admin-reports.ts and
    // admin-dashboard.ts. Never true for an order placed after Publish.
    isDemo: boolean().notNull().default(false),
    // Order editing (migration 0084): true when an admin set a custom/removed
    // shipping amount, so the amount is not re-derived from a shipping method.
    shippingOverride: boolean().notNull().default(false),
    // Migration 0086: the shipping method chosen at checkout / draft / edit (code
    // + name snapshot). NULL for legacy orders and orders with no shipping line.
    shippingMethodCode: text(),
    shippingMethodName: text(),
    // Stripe-canonical idempotency: a client-supplied key per checkout attempt.
    // Same (store, key) -> the same order, so a double-submit can't create two.
    idempotencyKey: text(),
    // The promotion applied to this order (single-coupon v1). promotion_usage is
    // the per-customer ledger that enforces per_customer_usage_limit.
    promotionId: uuid().references(() => promotion.id),
    shippingAddress: jsonb(),
    billingAddress: jsonb(),
    // Checkout-migration: high-entropy receipt token returned by /checkout and
    // carried (?rt=) to the confirmation page + Stripe return_url. The public
    // order-by-code read grants access on a token match OR authed ownership —
    // never bare-code (the order code is ~enumerable). (migration 0035)
    receiptToken: text(),
    // WP9.5: provenance for the customer link (session | email_match) + future
    // freeform keys. Kept as a separate JSONB so a structured linked_via query
    // is indexable later if the email-match rate climbs.
    metadata: jsonb(),
    placedAt: timestamp({ withTimezone: true }),
    // Soft-delete (trash). Null = live; non-null = trashed (hidden from every
    // order read — list/dashboard/reports/export — but restorable). Purge hard-
    // deletes. Mirrors the product/variant deletedAt convention. (migration 0033)
    deletedAt: timestamp({ withTimezone: true }),
    // Wire-facing lifecycle status (open|completed|cancelled|archived) —
    // Postgres STORED GENERATED column, a pure function of `state` +
    // `deleted_at` on THIS row only. Never written by application code (the
    // DB computes and stores it on every insert/update); see orders/status.ts
    // for the paymentStatus/fulfillmentStatus counterparts, which depend on
    // OTHER tables (payment/order_line/fulfillment) and so are computed at
    // read time instead of stored (migration 0080's header comment has the
    // full rationale). `text()`, not a pgEnum — see schema-core.ts's note by
    // the (removed) orderStatus enum for why a GENERATED column can't resolve
    // to a Postgres enum type. (migration 0080)
    status: text().notNull().generatedAlwaysAs(sql`(case
      when deleted_at is not null then 'archived'
      when state = 'Cancelled' then 'cancelled'
      when state = 'PendingPayment' then 'open'
      else 'completed'
    end)`),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [
    unique('order_store_code').on(t.storeId, t.code),
    unique('order_store_idempotency').on(t.storeId, t.idempotencyKey),
    check('order_status_check', sql`${t.status} in ('open', 'completed', 'cancelled', 'archived')`),
  ],
);

// Order editing (migration 0084). A +/- labelled amount applied to an order's
// grand total (untaxed). Replaced as a set by each committed edit; the full
// before/after history lives in `order_edit`. Cascades with the order.
export const orderAdjustment = pgTable('order_adjustment', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  orderId: uuid().notNull().references(() => order.id, { onDelete: 'cascade' }),
  label: text().notNull(),
  amount: integer().notNull(), // cents, may be negative
  actor: text(),
  createdAt: ts(),
});

// One row per committed edit session: the order snapshot before/after, the
// balance it produced and how it was settled. `idempotencyKey` makes the commit
// replay-safe; `fingerprint` binds a key to its exact payload.
export const orderEdit = pgTable('order_edit', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  orderId: uuid().notNull().references(() => order.id, { onDelete: 'cascade' }),
  idempotencyKey: text(),
  fingerprint: text(),
  before: jsonb().notNull(),
  after: jsonb().notNull(),
  balance: integer().notNull().default(0), // cents: new total - net paid (+ = customer owes)
  settlement: jsonb(),
  reason: text(),
  actor: text(),
  createdAt: ts(),
});

export const orderLine = pgTable('order_line', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  orderId: uuid().notNull().references(() => order.id),
  // Nullable: a variant may be deleted later. Order history survives via the
  // snapshot columns (rulebook §1: order snapshots are truth after checkout).
  variantId: uuid().references(() => productVariant.id),
  variantSku: text().notNull(), // snapshot at order time
  variantName: text().notNull(), // snapshot at order time
  metadata: jsonb(),
  quantity: integer().notNull(),
  unitPrice: integer().notNull(), // cents, snapshot at add
  lineSubtotal: integer().notNull(),
  lineDiscount: integer().notNull().default(0),
  lineTax: integer().notNull().default(0),
  lineTotal: integer().notNull(),
  fulfilledQty: integer().notNull().default(0),
  cancelledQty: integer().notNull().default(0),
  refundedQty: integer().notNull().default(0),
});

// Software entitlements issued from paid order lines. Store-scoped: RightSites
// can host ViewRight/CodeRight/etc. in one instance, while Damned/RH remain
// separate DB/API instances with their own license rows.
//
// STOREKIT (0066): order_id / order_line_id are nullable — a license minted
// from a verified Apple In-App Purchase has no order row; `source`
// distinguishes those ('order' | 'admin' | 'storekit' — plain text by design,
// so future provenance values don't need a migration to land).
export const license = pgTable(
  'license',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    customerId: uuid().references(() => customer.id),
    orderId: uuid().references(() => order.id),
    orderLineId: uuid().references(() => orderLine.id),
    appKey: text().notNull(),
    // License keys are unique PER APP, not globally — an admin-fixed key (e.g.
    // a creator code) only has to be unique within its app namespace.
    licenseKey: text().notNull(),
    status: licenseStatus().notNull().default('active'),
    source: text().notNull().default('order'),
    // Provenance for non-order issuance (source != 'order'): the authorizing
    // actor and the reason the license exists. Required by mintLicense.
    issuedBy: text(),
    issueReason: text(),
    seats: integer().notNull().default(1),
    updatesUntil: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    metadata: jsonb(),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [unique('license_app_key_unique').on(t.appKey, t.licenseKey)],
);

// A subscription links our order/license/customer to a Stripe Billing subscription.
// It IS backed by a real order (license.order_id is NOT NULL); the first paid
// invoice settles that order (issuing the license), renewals extend the license.
export const subscription = pgTable('subscription', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().references(() => customer.id),
  orderId: uuid().references(() => order.id),       // backing order (nullable: unlinked on order purge)
  licenseId: uuid().references(() => license.id),   // null until the first paid invoice issues it
  stripeSubscriptionId: text().notNull().unique(),
  stripeCustomerId: text(),
  priceId: text(),
  status: subscriptionStatus().notNull().default('incomplete'),
  currentPeriodEnd: timestamp({ withTimezone: true }),
  cancelAtPeriodEnd: boolean().notNull().default(false),
  createdAt: ts(),
  updatedAt: ts(),
});

export const licenseActivation = pgTable(
  'license_activation',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    licenseId: uuid().notNull().references(() => license.id),
    appKey: text().notNull(),
    deviceIdHash: text().notNull(),
    // UNIQUENESS NOTE (ra-007): the UNIQUE constraint on this column is enforced
    // by a PARTIAL index created in migration 0027:
    //   CREATE UNIQUE INDEX … ON license_activation (activation_token_hash)
    //   WHERE activation_token_hash IS NOT NULL
    // drizzle-kit does NOT model partial indexes, so it will never generate a
    // migration for this index — but it MUST NOT be allowed to DROP it either.
    // Never run `drizzle-kit generate` without reviewing the output for a
    // spurious DROP INDEX on license_activation_token_hash_unique.
    activationTokenHash: text(),
    deviceLabel: text(),
    // Licensing-engine delta (migration 0064): server-derived class+pool device
    // accounting, renewable lease fields, tombstone state, and canonical
    // entitlement-issuance markers.
    // `deviceClass` is the legacy courtesy label; `platform`/`pool` are
    // authoritative for the lease path. `pool` is ALWAYS server-derived from a
    // trusted source (platform for leases, activationSource for the legacy
    // activate route) — never accepted from a client.
    deviceClass: text(),
    platform: text(),
    pool: text(),
    // 'active' | 'removed' | 'revoked'. Remote revoke and offline removal both
    // keep the row as a tombstone (never hard-delete) so the generation/audit
    // trail survives; pool/seat counting filters to state='active' so a
    // tombstoned row frees its slot immediately.
    state: text().notNull().default('active'),
    // Bumped on every revoke/removal. A lease/entitlement carrying a stale
    // generation is rejected by the renew path — replay rejection +
    // "prevents stale reactivation".
    generation: integer().notNull().default(0),
    revokedAt: timestamp({ withTimezone: true }),
    removedAt: timestamp({ withTimezone: true }),
    leaseId: uuid(),
    leaseIssuedAt: timestamp({ withTimezone: true }),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    leaseGraceSeconds: integer(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Canonical signed-entitlement issuance inventory: null = legacy/unknown,
    // 2 = the signer-issued v2 token was recorded (activationId + appKey).
    entitlementTokenVersion: integer(),
    entitlementTokenIssuedAt: timestamp({ withTimezone: true }),
    activatedAt: ts(),
    lastSeenAt: ts(),
  },
  (t) => [unique('license_activation_device').on(t.licenseId, t.deviceIdHash)],
);

export const appRelease = pgTable(
  'app_release',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    appKey: text().notNull(),
    version: text().notNull(),
    channel: text().notNull().default('stable'),
    platform: text(),
    manifest: jsonb().notNull(),
    publishedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: ts(),
  },
  (t) => [unique('app_release_unique').on(t.storeId, t.appKey, t.channel, t.platform, t.version)],
);

export const downloadArtifact = pgTable(
  'download_artifact',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    appReleaseId: uuid().notNull().references(() => appRelease.id),
    artifactKey: text().notNull(),
    path: text().notNull(),
    sha256: text(),
    // bigint: download artifacts (installers, game/app bundles) routinely exceed
    // the 2 GB signed-int32 ceiling. mode:'number' is safe — JS numbers are exact
    // to ~9 PB, far beyond any real file.
    sizeBytes: bigint({ mode: 'number' }),
    createdAt: ts(),
  },
  (t) => [unique('download_artifact_key').on(t.storeId, t.artifactKey)],
);

export const payment = pgTable('payment', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  orderId: uuid().notNull().references(() => order.id),
  amount: integer().notNull(), // cents
  gatewayAccount: text(),
  gatewayMode: text(),
  currency: text(),
  method: text().notNull(), // nmi | sezzle | stripe
  providerRef: text(), // payment_intent / transactionId / sezzleOrderUuid
  state: paymentState().notNull().default('Pending'),
  metadata: jsonb(),
  errorMessage: text(),
  createdAt: ts(),
});

export const refund = pgTable('refund', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  attemptId: uuid(),
  paymentId: uuid().notNull().references(() => payment.id),
  orderId: uuid().notNull().references(() => order.id),
  amount: integer().notNull(), // cents
  reason: text(),
  state: refundState().notNull().default('Pending'),
  providerRef: text(), // WP3: gateway refund id (e.g. Stripe re_...); null for manual/cod
  metadata: jsonb(),
  itemsAmount: integer(),
  shippingAmount: integer(),
  adjustmentAmount: integer(),
  createdAt: ts(),
});

export const refundLine = pgTable('refund_line', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  refundId: uuid().notNull().references(() => refund.id),
  orderLineId: uuid().notNull().references(() => orderLine.id),
  quantity: integer().notNull(),
  amount: integer().notNull(), // cents
  restock: boolean().notNull().default(false),
});

// Multi-currency (additive, display-only). Orders are charged in the store base
// currency; these rates drive presentment conversion for the storefront. Real
// settlement in another currency needs a gateway (separate, gated work).
export const currencyRate = pgTable(
  'currency_rate',
  {
    storeId: uuid().notNull().references(() => store.id),
    currency: text().notNull(), // ISO-4217, e.g. 'EUR'
    rate: integer().notNull(), // units of `currency` per 1 base, scaled ×10000 (1.0834 → 10834)
    enabled: boolean().notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.currency] })],
);

// Multi-location inventory (additive). The aggregate `stock.onHand` remains the
// sellable total the reservation engine works against; these tables add
// per-location breakdown + transfers for fulfillment routing/visibility.
export const location = pgTable('location', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  name: text().notNull(),
  code: text().notNull(),
  address: jsonb(),
  isDefault: boolean().notNull().default(false),
  enabled: boolean().notNull().default(true),
  createdAt: ts(),
});

export const stockLocation = pgTable(
  'stock_location',
  {
    storeId: uuid().notNull().references(() => store.id),
    variantId: uuid().notNull().references(() => productVariant.id),
    locationId: uuid().notNull().references(() => location.id),
    onHand: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.locationId] })],
);

// Webhooks — outbox pattern. An endpoint subscribes to topics; events are
// enqueued as deliveries and pushed by the scheduler with HMAC signing + retry.
export const webhookEndpoint = pgTable('webhook_endpoint', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  url: text().notNull(),
  topics: text().array().notNull(), // e.g. ['order.created','order.paid'] or ['*']
  secret: text().notNull(), // HMAC-SHA256 signing secret
  enabled: boolean().notNull().default(true),
  createdAt: ts(),
});

export const webhookDelivery = pgTable('webhook_delivery', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  endpointId: uuid().notNull().references(() => webhookEndpoint.id),
  topic: text().notNull(),
  payload: jsonb().notNull(),
  status: text().notNull().default('pending'), // pending | processing | delivered | failed
  attempts: integer().notNull().default(0),
  lastError: text(),
  nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
});

// REL-4 (DISPATCH.md): email outbox mirroring the webhook pattern. Enqueued
// transactionally at the Paid transition; a scheduler pass (deliverEmails in
// email/outbox.ts) claims due rows under FOR UPDATE SKIP LOCKED and pushes
// them with exponential backoff + dead-letter after MAX_ATTEMPTS. Mirrors
// webhook_delivery shape but drops the endpoint FK — emails are addressed to
// a recipient, not a subscribed endpoint. Hand-written migration 0038.
export const emailOutbox = pgTable('email_outbox', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  kind: text().notNull(), // e.g. 'order_confirmation'
  recipient: text().notNull(),
  payload: jsonb().notNull(), // serialized sendEmail input (to, subject, html, text, from?)
  status: text().notNull().default('pending'), // pending | processing | sent | dead
  attempts: integer().notNull().default(0),
  lastError: text(),
  nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// APNs device tokens for the admin iOS app (0039). One row per physical device;
// `token` is unique, so re-registering rebinds the device to whoever is signed
// in now rather than leaving the previous operator subscribed. Deleted on
// logout, on APNs 410 Unregistered, and by cascade when the admin is removed.
export const adminDeviceToken = pgTable('admin_device_token', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id, { onDelete: 'cascade' }),
  adminUserId: uuid().notNull().references(() => adminUser.id, { onDelete: 'cascade' }),
  token: text().notNull(),
  // 'apns' (alert pushes) | 'live_activity' (push-to-start token, iOS 17.2+).
  // Different APNs topic + push-type — see 0039.
  kind: text().notNull().default('apns'),
  environment: text().notNull().default('production'), // production | sandbox (APNs host)
  topics: text().array().notNull().default(['order.paid']),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  createdAt: ts(),
});

// Transactional push outbox (0039) — same lifecycle as emailOutbox above.
// Enqueued in the txn that produced the event; the scheduler delivers with
// backoff and dead-letters after MAX_ATTEMPTS. No APNs call at the call site.
export const pushOutbox = pgTable('push_outbox', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  topic: text().notNull(), // 'order.paid' | 'order.created' | ...
  deviceToken: text().notNull(),
  environment: text().notNull().default('production'),
  payload: jsonb().notNull(), // serialized APNs payload (aps + custom keys)
  status: text().notNull().default('pending'), // pending | processing | sent | dead
  attempts: integer().notNull().default(0),
  lastError: text(),
  nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// Gift cards / store credit. A code carries a redeemable cent balance; checkout
// draws it down as a 'gift_card' tender. Store-scoped (RLS).
export const giftCard = pgTable('gift_card', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  code: text().notNull().unique(),
  initialBalance: integer().notNull(), // cents
  balance: integer().notNull(), // cents remaining
  currency: text().notNull().default('USD'),
  enabled: boolean().notNull().default(true),
  customerId: uuid().references(() => customer.id), // optional owner
  expiresAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
  updatedAt: ts(),
});

export const giftCardTransaction = pgTable('gift_card_transaction', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  giftCardId: uuid().notNull().references(() => giftCard.id),
  orderId: uuid().references(() => order.id),
  amount: integer().notNull(), // negative = redeem, positive = issue/top-up/refund
  createdAt: ts(),
});

// Loyalty points ledger (migration 0070, hand-written). APPEND-ONLY: a
// customer's balance is the SUM of their rows — never a stored counter. A DB
// trigger rejects UPDATE. Program settings live in store.config.loyalty.
// Store-scoped (FORCE RLS).
export const loyaltyLedgerKinds = ['earn', 'redeem', 'reverse', 'adjust', 'expire', 'import', 'bonus'] as const;
export type LoyaltyLedgerKind = typeof loyaltyLedgerKinds[number];
export const loyaltyLedger = pgTable('loyalty_ledger', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().notNull().references(() => customer.id),
  kind: text().$type<LoyaltyLedgerKind>().notNull(),
  points: integer().notNull(), // signed: + credits, − debits (integer points)
  // Provenance only — NOT foreign keys: ledger rows must survive an order
  // purge (append-only rows can't be detached, and deleting them would
  // change a balance).
  orderId: uuid(),
  refundId: uuid(),
  // Deterministic idempotency key for system postings (unique per store when
  // set): earn:<order>, redeem:<order>, <refund|cancel>:<id>:<leg>, import:...
  sourceRef: text(),
  expiresAt: timestamp({ withTimezone: true }), // credit lots only; null = never
  // Reversal that could not be fully posted because the customer had already
  // spent the points — recorded, never allowed to drive the balance negative.
  shortfall: integer().notNull().default(0),
  reason: text(),
  actor: text(),
  metadata: jsonb(),
  createdAt: ts(),
});

// Return / exchange requests (RMA). Approval restocks + records a refund through
// the existing refund machinery. Store-scoped (RLS).
export const returnRequest = pgTable('return_request', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  orderId: uuid().notNull().references(() => order.id),
  status: returnStatus().notNull().default('requested'),
  reason: text(),
  refundId: uuid().references(() => refund.id), // set when approved + refunded
  createdAt: ts(),
  updatedAt: ts(),
});

export const returnLine = pgTable('return_line', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  returnId: uuid().notNull().references(() => returnRequest.id),
  orderLineId: uuid().notNull().references(() => orderLine.id),
  quantity: integer().notNull(),
  restock: boolean().notNull().default(true),
});

export const fulfillment = pgTable('fulfillment', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  orderId: uuid().notNull().references(() => order.id),
  state: fulfillmentState().notNull().default('Pending'),
  trackingCode: text(),
  carrier: text(),
  // ADMIN-ESSENTIALS: partial fulfillment — the location it shipped from
  // (nullable: existing/legacy fulfillments and single-location stores don't
  // set one) and whether the customer notification email was requested for
  // THIS fulfillment (defaults true to match the pre-existing always-email
  // behavior of the whole-order /fulfill route).
  locationId: uuid().references(() => location.id),
  notifyCustomer: boolean().notNull().default(true),
  metadata: jsonb(),
  createdAt: ts(),
  updatedAt: ts(),
});

export const fulfillmentLine = pgTable('fulfillment_line', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  fulfillmentId: uuid().notNull().references(() => fulfillment.id),
  orderLineId: uuid().notNull().references(() => orderLine.id),
  quantity: integer().notNull(),
});

// ── inventory ───────────────────────────────────────────────────────────────
export const stock = pgTable('stock', {
  variantId: uuid().primaryKey().references(() => productVariant.id),
  storeId: uuid().notNull().references(() => store.id),
  onHand: integer().notNull().default(0),
  allocated: integer().notNull().default(0),
  // SEO-1: cache-version needs a live "did anything change" signal that
  // includes availability, not just catalog content — a store's shop page is
  // stale the instant a variant sells out even if no product/collection/blog
  // row changed. Migration 0068's set_updated_at() trigger bumps this on
  // every stock write, same mechanism as collection/blog_post.
  updatedAt: ts(),
});

export const stockMovement = pgTable('stock_movement', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  variantId: uuid().notNull().references(() => productVariant.id),
  delta: integer().notNull(),
  reason: text().notNull(),
  refOrderId: uuid().references(() => order.id),
  // ADMIN-ESSENTIALS: who made the adjustment (admin email, or a system
  // actor like 'gateway:reconciliation' / null for legacy call sites that
  // predate this column). Every movement is an append-only ledger row — an
  // adjustment is always a NEW row, never an edit of onHand/an old row, so
  // "never overwrite silently" holds structurally, not just by convention.
  actor: text(),
  createdAt: ts(),
});

