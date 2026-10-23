/**
 * SellRight schema. Rules: integer cents for money, UUID PKs, store_id on every
 * store-scoped table (Postgres RLS enforces isolation — see migrations).
 * Column names are snake_case (drizzle `casing: snake_case` in drizzle.config).
 * Commerce rules: docs/FEATURES.md and docs/ARCHITECTURE.md.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  smallint,
  bigint,
  boolean,
  timestamp,
  jsonb,
  unique,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ── enums ────────────────────────────────────────────────────────────────────
export const adminRole = pgEnum('admin_role', ['owner', 'manager', 'staff', 'read_only']);
export const productStatus = pgEnum('product_status', ['draft', 'active']);
export const orderState = pgEnum('order_state', [
  'PendingPayment',
  'Paid',
  'PartiallyRefunded',
  'Refunded',
  'Cancelled',
]);
// NOTE: `order.status` (schema-orders.ts) — the wire-facing open|completed|
// cancelled|archived projection of the row above — is declared `text()`,
// NOT a pgEnum like the others on this page. Postgres enum I/O/cast
// functions are STABLE, not IMMUTABLE (ALTER TYPE ... ADD VALUE can change
// the catalog), so a GENERATED ALWAYS AS expression may never resolve to an
// enum type — Postgres rejects it at DDL time with "generation expression is
// not immutable" regardless of how the expression casts. `text()` matches
// the existing plain-text-status convention already used elsewhere in this
// schema (webhookDelivery.status, emailOutbox.status, subscriber.status).
export const fulfillmentState = pgEnum('fulfillment_state', ['Pending', 'Shipped', 'Delivered', 'Cancelled']);
export const fulfillmentType = pgEnum('fulfillment_type', ['physical', 'digital_download', 'license', 'update_pass']);
export const paymentState = pgEnum('payment_state', [
  'Pending',
  'Authorized',
  'Settled',
  'Declined',
  'Failed',
]);
export const refundState = pgEnum('refund_state', ['Pending', 'Settled', 'Failed']);
export const returnStatus = pgEnum('return_status', ['requested', 'approved', 'rejected', 'received', 'refunded']);
export const promotionType = pgEnum('promotion_type', ['percentage', 'fixed', 'free_shipping', 'account_credit']);
// 'expired' is NOT auto-transitioned by any background job. Expiry is detected
// at read time by comparing NOW() against license.expires_at. The only admin-
// driven status transition is active → revoked. (ra-010)
export const licenseStatus = pgEnum('license_status', ['active', 'revoked', 'expired']);
export const subscriptionStatus = pgEnum('subscription_status', ['incomplete', 'active', 'past_due', 'canceled']);

export const ts = () => timestamp({ withTimezone: true }).notNull().defaultNow();

// ── tenancy ─────────────────────────────────────────────────────────────────
export const store = pgTable('store', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  currency: text().notNull().default('USD'),
  taxRate: integer().notNull().default(0), // basis points (875 = 8.75%); 0 = no tax. Fallback when no tax_zone matches.
  taxInclusive: boolean().notNull().default(false), // true = catalog prices already include tax (extract, don't add)
  shippingTaxable: boolean().notNull().default(false),
  config: jsonb(),
  createdAt: ts(),
  updatedAt: ts(),
});

// Per-destination tax rates. The matching zone (by ship-to country) overrides the
// store's flat taxRate; no match → store.taxRate. Store-scoped (RLS).
export const taxZone = pgTable('tax_zone', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  name: text().notNull(),
  countries: text().array().notNull(), // ISO-3166 alpha-2 list this zone covers
  rate: integer().notNull(), // basis points
  priority: integer().notNull().default(0), // higher wins when multiple zones match
  enabled: boolean().notNull().default(true),
});

export const adminUser = pgTable('admin_user', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  passwordHash: text(),
  totpSecret: text(),
  // Display name. Only ever set at claim time today (POST /v1/setup/claim);
  // nullable so every admin created by earlier flows (seed-admin, invites,
  // bootstrap) keeps working unchanged.
  name: text(),
  kind: text().notNull().default('human'), // 'agent' = API-token identity (docs/plans/2026-10-10-agent-role-v5.md)
  // One-click install (plan §1.3): install-wide authority, distinct from any
  // per-store `owner` role. Owns system operations (backup/restore trigger,
  // recovery-kit download, add-store, future update trigger). Owning a store
  // — even as 'owner' — never implies this. Set exactly once, by
  // POST /v1/setup/claim; never toggled by ordinary staff-management routes.
  isInstallationAdmin: boolean().notNull().default(false),
  // 0108: per-owner security epoch — bumped by trigger admin_user_security_epoch_trg on a logical TOTP change; every
  // passkey credential/challenge and step-up is stamped with it and valid only while equal (auth/passkeys.ts).
  securityEpoch: integer().notNull().default(0),
  // One-click install (plan §1.10): set once the installation admin has
  // downloaded the recovery kit via GET /v1/admin/system/recovery-kit. Gates
  // Publish (plan §1.5) alongside payments/email verification.
  recoveryKitDownloadedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
});

// One-click install (plan §1.4): single-use claim token minted by
// `sellright setup-link`, redeemed by POST /v1/setup/claim to create the
// installation administrator + first store in one transaction. Global and
// pre-auth — like staff_invite, isolation is the 256-bit token hash, not RLS.
// The route (not this schema) enforces "only while no installation admin
// exists" and invalidates prior unused tokens when a new one is issued.
export const setupClaimToken = pgTable('setup_claim_token', {
  id: uuid().primaryKey().defaultRandom(),
  tokenHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
});

export const adminUserStore = pgTable(
  'admin_user_store',
  {
    adminUserId: uuid().notNull().references(() => adminUser.id),
    storeId: uuid().notNull().references(() => store.id),
    role: adminRole().notNull().default('staff'),
    permissions: jsonb(), // optional per-action grants, e.g. { discounts: true, refunds: true }
  },
  (t) => [primaryKey({ columns: [t.adminUserId, t.storeId] })],
);

// Staff invitations. Looked up by token hash at accept time (BEFORE any store
// context), so — like `session` — this is RLS-exempt; isolation is the token.
export const staffInvite = pgTable('staff_invite', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  email: text().notNull(),
  role: adminRole().notNull().default('staff'),
  tokenHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  acceptedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
});

export const adminApiToken = pgTable('admin_api_token', {
  id: uuid().primaryKey().defaultRandom(),
  adminUserId: uuid().notNull().references(() => adminUser.id, { onDelete: 'cascade' }),
  storeId: uuid().notNull().references(() => store.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  tokenHash: text().notNull().unique(),
  createdBy: text(),
  lastUsedAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }),
  revokedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
});

// One-time 2FA recovery codes (0097). Global registry like admin_user — RLS-exempt, no store_id.
// Only sha256(code) is stored; used_at marks a spent code. See src/auth/second-factor.ts.
export const adminRecoveryCode = pgTable('admin_recovery_code', {
  id: uuid().primaryKey().defaultRandom(),
  adminUserId: uuid().notNull().references(() => adminUser.id, { onDelete: 'cascade' }),
  codeHash: text().notNull(),
  usedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
});

// Accepted TOTP time-steps per admin (0097): the durable, cross-process replay guard. See auth/second-factor.ts.
export const adminTotpUsedStep = pgTable('admin_totp_used_step', {
  adminUserId: uuid().notNull().references(() => adminUser.id, { onDelete: 'cascade' }),
  step: bigint({ mode: 'number' }).notNull(),
  usedAt: ts(),
}, (t) => [primaryKey({ columns: [t.adminUserId, t.step] })]);

/** bytea column (COSE public keys). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } });

// Passkeys (0108, docs/plans/2026-10-21-passkeys-and-federated-signin.md). Global registries like admin_recovery_code:
// RLS-exempt, no store_id, read through unsafeUnscopedDb. `epoch` = admin_user.security_epoch at issuance.
export const adminPasskeyCredential = pgTable('admin_passkey_credential', {
  id: uuid().primaryKey().defaultRandom(),
  adminUserId: uuid().notNull().references(() => adminUser.id, { onDelete: 'cascade' }),
  rpId: text().notNull(),
  credentialId: text().notNull(),
  publicKey: bytea().notNull(),
  counter: bigint({ mode: 'number' }).notNull().default(0),
  transports: text().array().notNull().default([]),
  deviceType: text().notNull(),
  backedUp: boolean().notNull(),
  aaguid: text(),
  label: text().notNull(),
  epoch: integer().notNull(),
  createdAt: ts(),
  lastUsedAt: timestamp({ withTimezone: true }),
}, (t) => [unique('admin_passkey_credential_rp_cred').on(t.rpId, t.credentialId), index('admin_passkey_credential_admin').on(t.adminUserId)]);

export const adminPasskeyChallenge = pgTable('admin_passkey_challenge', {
  challengeHash: text().primaryKey(),
  kind: text({ enum: ['register', 'login', 'step_up'] }).notNull(),
  rpId: text().notNull(),
  adminUserId: uuid().references(() => adminUser.id, { onDelete: 'cascade' }),
  sessionHash: text(),
  nonceHash: text().notNull(),
  epoch: integer(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  consumedAt: timestamp({ withTimezone: true }),
}, (t) => [index('admin_passkey_challenge_expires').on(t.expiresAt)]);

/** Admin auth journey tokens (0110, issue #333): login_2fa (password verified, code pending), totp_enroll (one
 *  session's pending sealed authenticator secret) and password_reset. Only sha256(token) is stored; single-use. */
export const adminAuthChallenge = pgTable('admin_auth_challenge', {
  tokenHash: text().primaryKey(),
  kind: text({ enum: ['login_2fa', 'totp_enroll', 'password_reset'] }).notNull(),
  adminUserId: uuid().notNull().references(() => adminUser.id, { onDelete: 'cascade' }),
  sessionHash: text(),
  credentialDigest: text(),
  secret: text(),
  epoch: integer().notNull(),
  attempts: integer().notNull().default(0),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  consumedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
}, (t) => [index('admin_auth_challenge_admin').on(t.adminUserId, t.kind), index('admin_auth_challenge_expires').on(t.expiresAt)]);

export const session = pgTable('session', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().references(() => store.id),
  customerId: uuid().references(() => customer.id),
  adminUserId: uuid().references(() => adminUser.id),
  tokenHash: text().notNull().unique(),
  legacyExpiresAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  // WS-B follow-up: when THIS session last re-verified the admin's password
  // (+ TOTP, if enabled). Step-up-gated routes (GET /v1/admin/system/
  // recovery-kit) require this within the last 5 minutes — see
  // requireStepUp() in routes/admin-helpers.ts. Per-session, not per-admin:
  // stepping up in one browser tab must never grant it to another session.
  stepUpAt: timestamp({ withTimezone: true }),
  // 0108: the owner's security_epoch when this session last stepped up; NULL (incl. rows written by an older engine) means
  // the step-up cannot authorize passkey management or any epoch-aware consumer (routes/admin-helpers.ts requireStepUpEpoch).
  stepUpEpoch: integer(),
  apiTokenId: uuid().references(() => adminApiToken.id, { onDelete: 'cascade' }),
  // 0098: last use of an ADMIN session (touched at most once a minute) for the idle timeout; null = created_at.
  lastSeenAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
});

// ── catalog ─────────────────────────────────────────────────────────────────
export const asset = pgTable('asset', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  type: text().notNull().default('image'),
  path: text().notNull(),
  width: integer(),
  height: integer(),
  alt: text(),
  createdAt: ts(),
});

export const product = pgTable(
  'product',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    status: productStatus().notNull().default('draft'),
    featuredAssetId: uuid().references(() => asset.id),
    vendor: text(),
    productType: text(),
    tags: text().array(),
    seoTitle: text(),
    seoDescription: text(),
    metafields: jsonb(), // arbitrary key/value app data
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [unique('product_store_slug').on(t.storeId, t.slug)],
);

export const productOptionGroup = pgTable('product_option_group', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  productId: uuid().notNull().references(() => product.id),
  name: text().notNull(),
  // Merchant-controlled display order among a product's option groups
  // (e.g. Size before Color). Scoped per productId, not globally — see
  // migration 0080's backfill and admin-catalog.ts's reorder endpoint.
  position: integer().notNull().default(0),
});

export const productOption = pgTable('product_option', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  groupId: uuid().notNull().references(() => productOptionGroup.id),
  value: text().notNull(),
  // Merchant-controlled display order among a group's values (e.g. S, M, L
  // instead of alphabetical). Scoped per groupId — see migration 0080.
  position: integer().notNull().default(0),
});

export const productVariant = pgTable(
  'product_variant',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    productId: uuid().notNull().references(() => product.id),
    sku: text().notNull(),
    name: text().notNull(),
    price: integer().notNull(), // cents
    salePrice: integer(), // cents, nullable
    compareAtPrice: integer(), // cents — "was" price for strikethrough display
    cost: integer(), // cents — unit cost (margin reporting; never shown to shoppers)
    preOrderPrice: integer(), // cents, nullable
    isPreOrder: boolean().notNull().default(false),
    shipDate: timestamp({ withTimezone: true }), // pre-order fulfillment hold
    fulfillmentType: fulfillmentType().notNull().default('physical'),
    appKey: text(), // e.g. viewright; set for software licenses/downloads/update passes
    artifactKey: text(), // optional direct download artifact key
    licenseSeats: integer().notNull().default(1), // device/activation allowance for issued licenses
    licenseDurationDays: integer(), // null = perpetual
    updatesDurationDays: integer(), // null = no update entitlement
    stripePriceId: text(), // set => this variant is a recurring (subscription) plan
    billingInterval: text(), // 'month' | 'year' (informational; cycle driven by Stripe)
    weightG: integer(),
    barcode: text(), // UPC/EAN/ISBN
    dimensions: jsonb(), // { length, width, height, unit }
    metafields: jsonb(),
    enabled: boolean().notNull().default(true),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [unique('variant_store_sku').on(t.storeId, t.sku)],
);

// store_id on every link table (defense-in-depth RLS — migration 0009).
export const variantOption = pgTable(
  'variant_option',
  {
    storeId: uuid().notNull().references(() => store.id),
    variantId: uuid().notNull().references(() => productVariant.id),
    optionId: uuid().notNull().references(() => productOption.id),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.optionId] })],
);

export const collection = pgTable(
  'collection',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    slug: text().notNull(),
    name: text().notNull(),
    parentId: uuid().references((): import('drizzle-orm/pg-core').AnyPgColumn => collection.id),
    description: text(),
    rules: jsonb(), // { match: 'all'|'any', conditions: [{ field, op, value }] } — null = manual collection
    published: boolean().notNull().default(true),
    publishedAt: timestamp({ withTimezone: true }),
    imageAssetId: uuid().references(() => asset.id),
    seoTitle: text(),
    seoDescription: text(),
    // SEO-1: sitemap <lastmod> + cache-version need a mutation timestamp;
    // collection never tracked one. Migration 0068 backfills the column and
    // adds a generic BEFORE UPDATE trigger (set_updated_at()) so every writer
    // (admin-catalog-collections, import, future code) bumps it for free —
    // no application code change required.
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [unique('collection_store_slug').on(t.storeId, t.slug)],
);

export const collectionProduct = pgTable(
  'collection_product',
  {
    storeId: uuid().notNull().references(() => store.id),
    collectionId: uuid().notNull().references(() => collection.id),
    productId: uuid().notNull().references(() => product.id),
    position: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.productId] })],
);

export const productAsset = pgTable(
  'product_asset',
  {
    storeId: uuid().notNull().references(() => store.id),
    productId: uuid().notNull().references(() => product.id),
    assetId: uuid().notNull().references(() => asset.id),
    position: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.assetId] })],
);

export const variantAsset = pgTable(
  'variant_asset',
  {
    storeId: uuid().notNull().references(() => store.id),
    variantId: uuid().notNull().references(() => productVariant.id),
    assetId: uuid().notNull().references(() => asset.id),
    position: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.assetId] })],
);

// ── customer & auth ─────────────────────────────────────────────────────────
export const customer = pgTable(
  'customer',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    email: text().notNull(),
    firstName: text(),
    lastName: text(),
    phone: text(),
    tags: text().array(),
    stripeCustomerId: text(),
    listmonkSubscribedAt: timestamp({ withTimezone: true }),
    googleSub: text(),
    appleUserId: text(),
    passwordHash: text(), // nullable for OAuth-only
    emailVerified: boolean().notNull().default(false),
    // 0108: bumped by trigger customer_security_epoch_trg on every password_hash change except the engine's in-place rehash.
    securityEpoch: integer().notNull().default(0),
    sheeridVerifications: jsonb(),
    activeVerifications: text().array(),
    verificationMetadata: jsonb(),
    // Birthday (month/day only — migration 0085) for the optional birthday bonus.
    birthMonth: smallint(),
    birthDay: smallint(),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [unique('customer_store_email').on(t.storeId, t.email)],
);

export const address = pgTable('address', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().notNull().references(() => customer.id),
  fullName: text(),
  line1: text().notNull(),
  line2: text(),
  city: text().notNull(),
  province: text(),
  postalCode: text(),
  country: text().notNull(),
  phone: text(),
  isDefaultShipping: boolean().notNull().default(false),
  isDefaultBilling: boolean().notNull().default(false),
});

// ── shipping & promotions ───────────────────────────────────────────────────
export const shippingMethod = pgTable('shipping_method', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  code: text().notNull(),
  name: text().notNull(),
  calculator: jsonb().notNull(), // { zones, rates, min, max, exclude }
  enabled: boolean().notNull().default(true),
});

export const promotion = pgTable('promotion', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  code: text(), // null = automatic
  type: promotionType().notNull(),
  value: integer().notNull(), // percentage points or fixed cents
  discountScope: text().$type<'line' | 'order'>().notNull().default('line'),
  // Source imports supply observed active-query rank; native rows may omit it.
  stackOrder: integer(),
  // R24 parity: a promotion can combine a percentage/fixed discount WITH free
  // shipping (DD's `order_percentage_discount` + `free_shipping` action
  // pair). `type` stays single-valued (percentage | fixed | free_shipping,
  // unchanged) so every existing free_shipping-only promotion keeps working;
  // this flag layers free shipping on TOP of a percentage/fixed promotion
  // instead of requiring a second promotion model. money/totals.ts checks
  // `type === 'free_shipping' || freeShipping` for the shipping waiver.
  freeShipping: boolean().notNull().default(false),
  conditions: jsonb(),
  startsAt: timestamp({ withTimezone: true }),
  endsAt: timestamp({ withTimezone: true }),
  usageLimit: integer(),
  perCustomerUsageLimit: integer(),
  usedCount: integer().notNull().default(0),
  priority: integer().notNull().default(0),
  exclusionGroup: text(),
  enabled: boolean().notNull().default(true),
  // 0052: bound affiliate recipient — presence drives auto-onboard/rotation
  // (affiliate/onboarding.ts). Raw-SQL writes predate this mapping.
  affiliateEmail: text(),
}, (t) => [
  check('promotion_discount_scope_check', sql`${t.discountScope} IN ('line', 'order')`),
  check('promotion_stack_order_check', sql`${t.stackOrder} IS NULL OR ${t.stackOrder} >= 0`),
]);

