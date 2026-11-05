import { sql } from 'drizzle-orm';
import * as s from '../db/schema.js';

/** The billed quantity of an order_line as a select expression (ordered less edit-removed); see line-quantity.ts. */
export const billedQuantitySql = sql<number>`(${s.orderLine.quantity} - ${s.orderLine.editRemovedQty})::int`;
/** Edit-removed-adjusted cancelled count (cancelled by a refund or cancellation only). */
export const billedCancelledSql = sql<number>`(${s.orderLine.cancelledQty} - ${s.orderLine.editRemovedQty})::int`;
