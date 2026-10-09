import { sql } from 'drizzle-orm';
import type { Tx } from '../../../src/db/client.js';
import * as s from '../../../src/db/schema.js';
import { payment as p, order as o } from '../../../src/db/schema-orders.js';
import type { PgTable } from 'drizzle-orm/pg-core';
// positive fixture for A-EFFECT-ENGINE
export const a = (tx: Tx) => tx.update(s.orderPendingEffect).set({ status: 'done' });
