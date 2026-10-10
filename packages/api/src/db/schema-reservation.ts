import { type AnyPgColumn, boolean, check, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { store } from './schema-core.js';
import { order, payment } from './schema-orders.js';

/**
 * Order reservations (migration 0091; PAYMENT-TIMING.md §3.2). A durable hold an
 * order places on a thing another order must not also take. Lifecycle lives in
 * payments/reservation.ts; locks are L4 (STOREKIT.md §5.1).
 */
export const orderReservation = pgTable('order_reservation', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id, { onDelete: 'cascade' }),
  orderId: uuid().notNull().references(() => order.id, { onDelete: 'cascade' }),
  kind: text().notNull(),
  ownerKey: text().notNull(),
  state: text().notNull().default('held'), // held | consumed | released
  holder: jsonb().notNull().default({}),
  releaseOnFullRefund: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }),
  releaseRequestedAt: timestamp({ withTimezone: true }),
  releaseReason: text(),
  releasedAt: timestamp({ withTimezone: true }),
  releasedUnverified: boolean().notNull().default(false),
  consumedAt: timestamp({ withTimezone: true }),
  consumedPaymentId: uuid().references((): AnyPgColumn => payment.id, { onDelete: 'set null' }),
  consumedOperationId: text(),
  providerTerminalAt: timestamp({ withTimezone: true }),
}, (t) => [
  check('order_reservation_state_check', sql`${t.state} in ('held', 'consumed', 'released')`),
  check(
    'order_reservation_shape_check',
    sql`(${t.state} = 'held' and ${t.consumedAt} is null and ${t.releasedAt} is null and ${t.providerTerminalAt} is null)
      or (${t.state} = 'consumed' and ${t.consumedAt} is not null and ${t.providerTerminalAt} is not null and ${t.releasedAt} is null)
      or (${t.state} = 'released' and ${t.releasedAt} is not null and ${t.providerTerminalAt} is not null)`,
  ),
  unique('order_reservation_order_owner').on(t.orderId, t.kind, t.ownerKey),
  uniqueIndex('order_reservation_live_owner')
    .on(t.storeId, t.kind, t.ownerKey)
    .where(sql`${t.state} in ('held', 'consumed')`),
  index('order_reservation_order_idx').on(t.storeId, t.orderId),
  index('order_reservation_release_pending')
    .on(t.storeId, t.releaseRequestedAt)
    .where(sql`${t.state} = 'held' and ${t.releaseRequestedAt} is not null`),
]);
