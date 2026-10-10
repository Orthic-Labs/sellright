import { sql } from 'drizzle-orm';
import type { Tx } from '../../../src/db/client.js';
import * as s from '../../../src/db/schema.js';
import { payment as p, order as o } from '../../../src/db/schema-orders.js';
import type { PgTable } from 'drizzle-orm/pg-core';
export const a = (tx: Tx, v: typeof s.order.$inferInsert) => tx.insert(s.order).values({ ...v, state: 'PendingPayment' }).onConflictDoUpdate({ target: s.order.id, set: { state: 'Paid' } });
