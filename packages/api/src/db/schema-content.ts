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
import { asset, customer, productVariant, promotion, store, ts } from './schema-core.js';
import { order } from './schema-orders.js';

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

// ── newsletter + waitlist subscribers (SUBSCRIBER-1, migration 0041) ────────
// One table for both newsletter and waitlist signups, discriminated by
// `kind` + `topic`. `topic` is NOT NULL DEFAULT '' so the (store_id, email,
// kind, topic) UNIQUE works for the general newsletter (Postgres treats NULL
// as distinct in unique constraints). Confirmation + unsubscribe use a
// per-row `token` (gen_random_uuid()); never derived from the email.
// `last_sent_at` is the mailbomb guard: at most one confirmation per address
// per hour, checked inside the signup transaction.
// `listmonk_synced_at` is the downstream marker — the listmonk-sync job
// claims confirmed + unsynced rows and pushes them to Listmonk, the same
// outbox-shaped pattern email_outbox (0038) and webhook_delivery (0031) use.
export const subscriber = pgTable(
  'subscriber',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    email: text().notNull(),
    name: text(),
    kind: text({ enum: ['newsletter', 'waitlist'] }).notNull(),
    topic: text().notNull().default(''),
    status: text({ enum: ['pending', 'confirmed', 'unsubscribed', 'bounced'] }).notNull().default('pending'),
    token: uuid().notNull().defaultRandom(),
    confirmedAt: timestamp({ withTimezone: true }),
    unsubscribedAt: timestamp({ withTimezone: true }),
    lastSentAt: timestamp({ withTimezone: true }),
    source: text({ enum: ['storefront', 'checkout', 'import', 'api'] }),
    meta: jsonb(),
    listmonkSyncedAt: timestamp({ withTimezone: true }),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [
    // One row per (store, email, kind, topic). The migration marks `topic`
    // NOT NULL DEFAULT '' so empty-string matches collapse correctly.
    unique('subscriber_store_email_kind_topic_key').on(t.storeId, t.email, t.kind, t.topic),
    unique('subscriber_token_key').on(t.token),
  ],
);

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
  // Hard TTL: the cart-cleanup job deletes idle/empty carts past this instant.
  // Set on create + extended on every line mutation (cartExpiry helper).
  // (migration 0032)
  expiresAt: timestamp({ withTimezone: true }),
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

