import { sql } from 'drizzle-orm';
import type { Tx } from '../../../src/db/client.js';
import * as s from '../../../src/db/schema.js';
import { payment as p, order as o } from '../../../src/db/schema-orders.js';
import type { PgTable } from 'drizzle-orm/pg-core';
// positive fixture for A-IMPORT-ORDERS
export const a = (tx: Tx, o2: Array<typeof s.order.$inferInsert>, p2: Array<typeof s.payment.$inferInsert>) => [tx.insert(s.order).values(o2), tx.insert(s.payment).values(p2)];
