import { sql } from 'drizzle-orm';
import type { Tx } from '../../../src/db/client.js';
import * as s from '../../../src/db/schema.js';
import { payment as p, order as o } from '../../../src/db/schema-orders.js';
import type { PgTable } from 'drizzle-orm/pg-core';
export const a = async (c: { query(q: string): Promise<unknown> }, tx: Tx) => { await tx.$client.query('INSERT INTO payment (id) VALUES (1)'); await tx.$client.query('COPY payment FROM STDIN'); };
