/** DB test (sellright_test only): iterateExportRows yields exactly the rows/order of fetchExportRows across chunk boundaries. */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { fetchExportRows, iterateExportRows, parseExportFilters } from './export.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'export-iterate.db.test.ts');

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

beforeAll(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, 'export-iter', 'export-iter')`);
    // 7 orders, three sharing one timestamp to exercise the (date, code) tiebreak.
    for (let i = 0; i < 7; i++) {
      await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, subtotal, grand_total, placed_at)
        VALUES (gen_random_uuid(), ${STORE}, ${`O-IT-${i}`}, 'Paid'::order_state, 'USD', 100, 100, ${i < 3 ? '2026-01-01T00:00:00Z' : `2026-01-0${i}T00:00:00Z`}::timestamptz)`);
    }
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });

describe('iterateExportRows', () => {
  for (const chunk of [1, 2, 3, 100]) {
    it(`matches fetchExportRows with chunk size ${chunk}`, async () => {
      const f = parseExportFilters(() => undefined);
      const f2 = { ...f, from: '2025-01-01', to: '2027-01-01' };
      const all = await fetchExportRows(STORE, f2, 'order');
      const got: string[] = [];
      for await (const rows of iterateExportRows(STORE, f2, 'order', chunk)) got.push(...rows.map((r) => r.code));
      expect(got).toEqual(all.map((r) => r.code));
      expect(got.length).toBe(7);
    });
  }
});
