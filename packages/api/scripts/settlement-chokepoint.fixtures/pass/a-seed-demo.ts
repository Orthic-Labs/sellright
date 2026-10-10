import { sql } from 'drizzle-orm';
import type { Tx } from '../../../src/db/client.js';
import * as s from '../../../src/db/schema.js';
import { payment as p, order as o } from '../../../src/db/schema-orders.js';
import type { PgTable } from 'drizzle-orm/pg-core';
// positive fixture for A-SEED-DEMO
export const a = (tx: Tx, i: number) => tx.insert(s.order).values({ storeId: 's', code: 'D', state: i === 3 ? 'PendingPayment' : 'Paid', currency: 'USD', subtotal: 1, grandTotal: 1 });
