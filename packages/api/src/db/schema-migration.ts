/** Frozen source-session grants & one-shot browser cart receipts. No raw source token is persisted. */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, boolean, jsonb, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { store, customer, session, ts } from './schema-core.js';
import { cart } from './schema-content.js';

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
