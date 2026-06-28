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
export const fulfillmentState = pgEnum('fulfillment_state', ['Pending', 'Shipped', 'Delivered']);
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
});

export const productOption = pgTable('product_option', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  groupId: uuid().notNull().references(() => productOptionGroup.id),
  value: text().notNull(),
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
    passwordHash: text(), // nullable for OAuth-only
    emailVerified: boolean().notNull().default(false),
    sheeridVerifications: jsonb(),
    activeVerifications: text().array(),
    verificationMetadata: jsonb(),
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
  conditions: jsonb(),
  startsAt: timestamp({ withTimezone: true }),
  endsAt: timestamp({ withTimezone: true }),
  usageLimit: integer(),
  perCustomerUsageLimit: integer(),
  usedCount: integer().notNull().default(0),
  priority: integer().notNull().default(0),
  exclusionGroup: text(),
  enabled: boolean().notNull().default(true),
});

