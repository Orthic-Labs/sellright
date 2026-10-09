/**
 * ONE definition of "usable tender": a Settled payment that is not a flagged
 * duplicate capture (D4). A duplicate capture is money the order never needed;
 * it is refundable but must never count toward what the order has been paid,
 * even before it is refunded. Used by amountDueForOrder, order-facts and the
 * status SQL so the three can't drift.
 */
import { sql, type SQL } from 'drizzle-orm';
import * as s from '../db/schema.js';

/** Drizzle fragment on the `payment` table (query builder). */
export const usableTenderSql: SQL = sql`${s.payment.state} = 'Settled' and coalesce((${s.payment.metadata}->>'duplicate')::boolean, false) = false`;

/** Raw-SQL fragment for an aliased payment row, e.g. `p`. Alias must be a trusted literal. */
export const usableTenderRawSql = (alias: string): SQL =>
  sql`${sql.raw(alias)}.state = 'Settled' and coalesce((${sql.raw(alias)}.metadata->>'duplicate')::boolean, false) = false`;
