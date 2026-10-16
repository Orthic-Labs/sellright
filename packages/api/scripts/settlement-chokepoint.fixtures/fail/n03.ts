import { sql } from 'drizzle-orm';
import type { Tx } from '../../../src/db/client.js';
import * as s from '../../../src/db/schema.js';
import { payment as p, order as o } from '../../../src/db/schema-orders.js';
import type { PgTable } from 'drizzle-orm/pg-core';
function typed(tx: Tx, t: typeof s.payment) { return tx.insert(t).values({} as never); }
function base(tx: Tx, t: PgTable) { return tx.insert(t).values({} as never); }
export const a = (tx: Tx) => [typed(tx, s.payment), base(tx, s.payment)];
