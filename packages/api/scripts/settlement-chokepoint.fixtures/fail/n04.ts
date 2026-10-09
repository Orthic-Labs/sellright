import { sql } from 'drizzle-orm';
import type { Tx } from '../../../src/db/client.js';
import * as s from '../../../src/db/schema.js';
import { payment as p, order as o } from '../../../src/db/schema-orders.js';
import type { PgTable } from 'drizzle-orm/pg-core';
export const a = (tx: Tx, st: string) => tx.insert(s.order).values([{ storeId: st, code: 'A', state: 'PendingPayment', currency: 'USD', subtotal: 1, grandTotal: 1 }, { storeId: st, code: 'B', state: 'Paid', currency: 'USD', subtotal: 1, grandTotal: 1 }]);
