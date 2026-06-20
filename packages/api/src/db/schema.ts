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

const ts = () => timestamp({ withTimezone: true }).notNull().defaultNow();

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
    // Stripe-canonical idempotency: a client-supplied key per checkout attempt.
    // Same (store, key) -> the same order, so a double-submit can't create two.
    idempotencyKey: text(),
    // The promotion applied to this order (single-coupon v1). promotion_usage is
    // the per-customer ledger that enforces per_customer_usage_limit.
    promotionId: uuid().references(() => promotion.id),
    shippingAddress: jsonb(),
    billingAddress: jsonb(),
    // WP9.5: provenance for the customer link (session | email_match) + future
    // freeform keys. Kept as a separate JSONB so a structured linked_via query
    // is indexable later if the email-match rate climbs.
    metadata: jsonb(),
    placedAt: timestamp({ withTimezone: true }),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [
    unique('order_store_code').on(t.storeId, t.code),
    unique('order_store_idempotency').on(t.storeId, t.idempotencyKey),
  ],
);

export const orderLine = pgTable('order_line', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  orderId: uuid().notNull().references(() => order.id),
  // Nullable: a variant may be deleted later. Order history survives via the
  // snapshot columns (rulebook §1: order snapshots are truth after checkout).
  variantId: uuid().references(() => productVariant.id),
  variantSku: text().notNull(), // snapshot at order time
  variantName: text().notNull(), // snapshot at order time
  quantity: integer().notNull(),
  unitPrice: integer().notNull(), // cents, snapshot at add
  lineSubtotal: integer().notNull(),
  lineDiscount: integer().notNull().default(0),
  lineTax: integer().notNull().default(0),
  lineTotal: integer().notNull(),
  fulfilledQty: integer().notNull().default(0),
  refundedQty: integer().notNull().default(0),
});

// Software entitlements issued from paid order lines. Store-scoped: Right Apps
// can host ViewRight/CodeRight/etc. in one instance, while Damned/RH remain
// separate DB/API instances with their own license rows.
export const license = pgTable(
  'license',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    customerId: uuid().references(() => customer.id),
    orderId: uuid().notNull().references(() => order.id),
    orderLineId: uuid().notNull().references(() => orderLine.id),
    appKey: text().notNull(),
    licenseKey: text().notNull().unique(),
    status: licenseStatus().notNull().default('active'),
    seats: integer().notNull().default(1),
    updatesUntil: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    metadata: jsonb(),
    createdAt: ts(),
    updatedAt: ts(),
  },
);

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
  paymentId: uuid().notNull().references(() => payment.id),
  orderId: uuid().notNull().references(() => order.id),
  amount: integer().notNull(), // cents
  reason: text(),
  state: refundState().notNull().default('Pending'),
  providerRef: text(), // WP3: gateway refund id (e.g. Stripe re_...); null for manual/cod
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
});

export const stockMovement = pgTable('stock_movement', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  variantId: uuid().notNull().references(() => productVariant.id),
  delta: integer().notNull(),
  reason: text().notNull(),
  refOrderId: uuid().references(() => order.id),
  createdAt: ts(),
});

// ── infra (safety rails) ────────────────────────────────────────────────────
// WP2d: customer_token — one-time tokens for password reset / email verify / set-password.
export const customerToken = pgTable('customer_token', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().notNull().references(() => customer.id),
  // Compile-time enum — typos in `kind` fail at the TS layer, not at insert.
  // The DB-level CHECK constraint is added by migration 0023 (defense in depth).
  kind: text({ enum: ['password_reset', 'email_verify', 'set_password'] }).notNull(),
  tokenHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
});

export const processedEvent = pgTable('processed_event', {
  id: text().primaryKey(), // provider event id (idempotency)
  storeId: uuid().references(() => store.id),
  type: text().notNull(),
  processedAt: ts(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  actor: text(),
  entity: text().notNull(),
  entityId: text(),
  action: text().notNull(),
  fromState: text(),
  toState: text(),
  data: jsonb(),
  at: ts(),
});

// ── DD-parity: affiliate + blog ─────────────────────────────────────────────
export const affiliate = pgTable('affiliate', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  promotionId: uuid().notNull().references(() => promotion.id).unique(),
  email: text().notNull(),
  accessToken: text().notNull().unique(),
  onboardedAt: ts(),
});

export const affiliateSettle = pgTable('affiliate_settle', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  promotionId: uuid().notNull().references(() => promotion.id),
  amountCents: integer().notNull(),
  periodStartAt: timestamp({ withTimezone: true }),
  periodEndAt: timestamp({ withTimezone: true }).notNull(),
  settledAt: ts(),
  txRef: text(),
  notes: text(),
});

export const blogPost = pgTable(
  'blog_post',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    title: text().notNull(),
    slug: text().notNull(),
    excerpt: text(),
    body: text(),
    bodyHtml: text(),
    authorName: text(),
    readingTime: integer(),
    featuredAssetId: uuid().references(() => asset.id),
    tags: jsonb(),
    isPublished: boolean().notNull().default(false),
    publishDate: timestamp({ withTimezone: true }),
    seoTitle: text(),
    seoDescription: text(),
  },
  (t) => [unique('blog_store_slug').on(t.storeId, t.slug)],
);

// ── cart (SEPARATE from orders — recovery + analytics, never shown as an order) ──
// The storefront keeps a snappy local cart and syncs it here for persistence,
// cross-device recovery, and abandonment/funnel analytics. An order is created
// from a cart only at checkout (cart.converted_order_id links the two).
export const cartStatus = pgEnum('cart_status', ['active', 'abandoned', 'converted']);

export const cart = pgTable('cart', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().references(() => customer.id),
  email: text(), // captured for guest abandoned-cart recovery (no account yet)
  token: text().notNull().unique(), // device/guest cart token
  status: cartStatus().notNull().default('active'),
  convertedOrderId: uuid().references(() => order.id),
  createdAt: ts(),
  updatedAt: ts(),
});

export const cartLine = pgTable(
  'cart_line',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    cartId: uuid().notNull().references(() => cart.id),
    variantId: uuid().references(() => productVariant.id),
    sku: text().notNull(), // snapshot (survives variant deletion, for analytics)
    quantity: integer().notNull(),
    createdAt: ts(),
  },
  (t) => [unique('cart_line_cart_sku').on(t.cartId, t.sku)],
);

// ── promotion usage ledger (enforce per_customer_usage_limit; audit which order
//    used which promo). One row per (promotion, order). Migration 0009. ────────
export const promotionUsage = pgTable(
  'promotion_usage',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    promotionId: uuid().notNull().references(() => promotion.id),
    customerId: uuid().references(() => customer.id),
    orderId: uuid().notNull().references(() => order.id),
    createdAt: ts(),
  },
  (t) => [unique('promotion_usage_promo_order').on(t.promotionId, t.orderId)],
);

// ── saved payment methods (gateway vault refs — Stripe/PayPal). NEVER a PAN. ──
export const paymentMethod = pgTable('payment_method', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().notNull().references(() => customer.id),
  gateway: text().notNull(), // stripe | paypal | nmi | sezzle
  providerCustomerRef: text(), // Stripe customer id / PayPal payer id
  providerMethodRef: text(), // payment_method / token id
  brand: text(),
  last4: text(),
  expMonth: integer(),
  expYear: integer(),
  isDefault: boolean().notNull().default(false),
  createdAt: ts(),
});

export type Store = typeof store.$inferSelect;
export type Order = typeof order.$inferSelect;
export type ProductVariant = typeof productVariant.$inferSelect;
