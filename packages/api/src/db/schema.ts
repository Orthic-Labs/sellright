/**
 * SellRight schema. Rules: integer cents for money, UUID PKs, store_id on every
 * store-scoped table (Postgres RLS enforces isolation — see migrations).
 * Column names are snake_case (drizzle `casing: snake_case` in drizzle.config).
 * Commerce rules: docs/SELLRIGHT-ECOMMERCE-RULEBOOK-v1.md.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  unique,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ── enums ───────────────────────────────────────────────────────────────────
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
export const paymentState = pgEnum('payment_state', [
  'Pending',
  'Authorized',
  'Settled',
  'Declined',
  'Failed',
]);
export const refundState = pgEnum('refund_state', ['Pending', 'Settled', 'Failed']);
export const promotionType = pgEnum('promotion_type', ['percentage', 'fixed', 'free_shipping']);

const ts = () => timestamp({ withTimezone: true }).notNull().defaultNow();

// ── tenancy ─────────────────────────────────────────────────────────────────
export const store = pgTable('store', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  currency: text().notNull().default('USD'),
  taxRate: integer().notNull().default(0), // basis points (875 = 8.75%); 0 = no tax
  shippingTaxable: boolean().notNull().default(false),
  config: jsonb(),
  createdAt: ts(),
  updatedAt: ts(),
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
  },
  (t) => [primaryKey({ columns: [t.adminUserId, t.storeId] })],
);

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
    preOrderPrice: integer(), // cents, nullable
    isPreOrder: boolean().notNull().default(false),
    shipDate: timestamp({ withTimezone: true }), // pre-order fulfillment hold
    weightG: integer(),
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
