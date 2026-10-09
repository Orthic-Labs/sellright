import { sql } from 'drizzle-orm';
import type { Tx } from '../../../src/db/client.js';
import * as s from '../../../src/db/schema.js';
import { payment as p, order as o } from '../../../src/db/schema-orders.js';
import type { PgTable } from 'drizzle-orm/pg-core';
import { recordSettlementOperation } from '../../../src/payments/settlement/record.js';
export const a = (tx: Tx) => recordSettlementOperation(tx, { storeId: 'x', kind: 'duplicate_capture_recorded', operationId: 'p', mutations: [], effects: [{ kind: 'license_issue' }] });
