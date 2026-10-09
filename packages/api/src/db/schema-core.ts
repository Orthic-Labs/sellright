/**
 * SellRight schema. Rules: integer cents for money, UUID PKs, store_id on every
 * store-scoped table (Postgres RLS enforces isolation — see migrations).
 * Column names are snake_case (drizzle `casing: snake_case` in drizzle.config).
 * Commerce rules: docs/FEATURES.md and docs/ARCHITECTURE.md.
 */
import {
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
export const promotionType = pgEnum('promotion_type', ['percentage', 'fixed', 'free_shipping']);
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
  // One-click install (plan §1.3): install-wide authority, distinct from any
  // per-store `owner` role. Owns system operations (backup/restore trigger,
  // recovery-kit download, add-store, future update trigger). Owning a store
  // — even as 'owner' — never implies this. Set exactly once, by
  // POST /v1/setup/claim; never toggled by ordinary staff-management routes.
  isInstallationAdmin: boolean().notNull().default(false),
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

export const session = pgTable('session', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().references(() => store.id),
  customerId: uuid().references(() => customer.id),
  adminUserId: uuid().references(() => adminUser.id),
  tokenHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  // WS-B follow-up: when THIS session last re-verified the admin's password
  // (+ TOTP, if enabled). Step-up-gated routes (GET /v1/admin/system/
  // recovery-kit) require this within the last 5 minutes — see
  // requireStepUp() in routes/admin-helpers.ts. Per-session, not per-admin:
  // stepping up in one browser tab must never grant it to another session.
  stepUpAt: timestamp({ withTimezone: true }),
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
  value: integer().notNull(), // percent (basis points) or fixed cents
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
});

