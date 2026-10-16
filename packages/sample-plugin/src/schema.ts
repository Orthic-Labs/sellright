import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { store, ts } from '@sellright/api/schema';

/** A plugin-owned, store-scoped table. FK target and timestamp helper come from the public schema surface. */
export const sampleNote = pgTable('sample_note', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  body: text().notNull(),
  createdAt: ts(),
});
