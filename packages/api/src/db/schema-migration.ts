/** Retained source records, session grants & one-shot cart receipts. No raw source token is persisted. */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, boolean, jsonb, integer, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { store, customer, session, ts } from './schema-core.js';
import { cart } from './schema-content.js';

/** Incomplete source address-book entries. Never eligible for checkout. */
export const customerAddressDraft = pgTable('customer_address_draft', {
  id: uuid().primaryKey(), storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().notNull().references(() => customer.id, { onDelete: 'cascade' }),
  sourceKey: text().notNull(), sourceId: text().notNull(), sourceCustomerId: text().notNull(),
  sourceDigest: text().notNull(),
  fullName: text(), line1: text(), line2: text(), city: text(), province: text(), postalCode: text(), phone: text(),
  sourceCountryId: text(), countryCode: text(),
  isDefaultShipping: boolean(), isDefaultBilling: boolean(),
}, t => [unique('address_draft_source_identity').on(t.storeId, t.sourceKey, t.sourceId)]);

/** Private source facts, structurally separate from operational payments. */
export const financialPaymentArchive = pgTable('financial_payment_archive', {
  id: uuid().primaryKey(), storeId: uuid().notNull().references(() => store.id),
  sourceKey: text().notNull(), sourceId: text().notNull(), sourceDigest: text().notNull(),
  sourceCreatedAt: text(), sourceOrderId: text(),
  method: text(), state: text(), amount: integer(), transactionId: text(),
  metadata: text(), errorMessage: text(),
  // Context supplied by migration config; never evidence of payment currency.
  importCurrencyContext: text().notNull(),
  // PostgreSQL JSON text bypasses JavaScript number parsing, including in manifests.
  sourceRecord: text().notNull(),
  sourceRefunds: text().array().notNull().default(sql`'{}'::text[]`),
  sourceReferences: text().array().notNull().default(sql`'{}'::text[]`),
}, t => [unique('payment_archive_source_identity').on(t.storeId, t.sourceKey, t.sourceId)]);

export const legacySessionGrant = pgTable('legacy_session_grant', {
  id: uuid().primaryKey(),
  storeId: uuid().notNull().references(() => store.id),
  sourceKey: text().notNull(),
  sourceSessionId: text().notNull(),
  sourceUserId: text(),
  sourceCustomerId: text(),
  sourceEmail: text(),
  tokenHash: text().notNull(),
  authenticated: boolean().notNull(),
  customerId: uuid().references(() => customer.id, { onDelete: 'cascade' }),
  // SET NULL is a durable revocation tombstone: bootstrap never recreates a deleted session.
  sessionId: uuid().references(() => session.id, { onDelete: 'set null' }),
  cartId: uuid().references(() => cart.id, { onDelete: 'set null' }),
  couponCode: text(),
  countryCode: text(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: ts(),
}, t => [unique('legacy_grant_store_hash').on(t.storeId, t.tokenHash),
  unique('legacy_grant_source_session').on(t.storeId, t.sourceKey, t.sourceSessionId)]);

export const legacyCartClaim = pgTable('legacy_cart_claim', {
  id: uuid().primaryKey(),
  storeId: uuid().notNull().references(() => store.id),
  claimHash: text().notNull(),
  payloadHash: text().notNull(),
  grantId: uuid().references(() => legacySessionGrant.id, { onDelete: 'cascade' }),
  sourceOnly: boolean().notNull().default(false),
  retiredAt: timestamp({ withTimezone: true }),
  cartId: uuid().references(() => cart.id, { onDelete: 'set null' }),
  couponCode: text(),
  countryCode: text(),
  unresolved: jsonb().$type<Array<{ variantId: string; quantity: number }>>().notNull().default([]),
  createdAt: ts(),
}, t => [unique('legacy_claim_store_hash').on(t.storeId, t.claimHash),
  uniqueIndex('legacy_claim_source_grant').on(t.grantId).where(sql`${t.sourceOnly}`),
  uniqueIndex('legacy_claim_grant').on(t.grantId).where(sql`NOT ${t.sourceOnly}`),
  uniqueIndex('legacy_claim_cart').on(t.cartId).where(sql`NOT ${t.sourceOnly}`)]);
