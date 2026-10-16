/**
 * Product reviews (migration 0085, hand-written). Store-scoped (FORCE RLS).
 * One review per product per reviewer email; moderated before it is public.
 * The aggregate (average/count) is derived from approved rows — never stored.
 */
import { pgTable, uuid, text, integer, smallint, boolean, timestamp } from 'drizzle-orm/pg-core';
import { store, customer, product, ts } from './schema-core.js';

export const productReviewStatuses = ['pending', 'approved', 'rejected'] as const;
export type ProductReviewStatus = typeof productReviewStatuses[number];

export const productReview = pgTable('product_review', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  productId: uuid().notNull().references(() => product.id, { onDelete: 'cascade' }),
  customerId: uuid().references(() => customer.id, { onDelete: 'set null' }),
  // Provenance of the verified-buyer proof (not a FK: reviews outlive order purges).
  orderId: uuid(),
  authorName: text().notNull(),
  authorEmail: text().notNull(), // normalized; never exposed publicly
  rating: smallint().notNull(),
  title: text(),
  body: text().notNull(),
  status: text().$type<ProductReviewStatus>().notNull().default('pending'),
  verifiedBuyer: boolean().notNull().default(false),
  reply: text(),
  repliedAt: timestamp({ withTimezone: true }),
  bonusPoints: integer().notNull().default(0),
  moderatedBy: text(),
  moderatedAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
  updatedAt: ts(),
});
