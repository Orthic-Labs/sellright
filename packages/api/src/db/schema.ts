import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Tenancy root. Every store-scoped table will carry store_id + Postgres RLS
 * (see docs/BUILD-PLAN-RH-v1.md §7). M0 ships only this table to prove the
 * Drizzle + migration pipeline; the full schema lands in M1.
 */
export const store = pgTable('store', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('USD'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Store = typeof store.$inferSelect;
export type NewStore = typeof store.$inferInsert;
