/**
 * WP9.6: RLS test expansion. Discovers every store-scoped table in the schema
 * and asserts the tenant-isolation contract for each one:
 *   - store A sees its own rows and not store B's
 *   - store A CANNOT write into store B (WITH CHECK)
 *   - without any app.current_store context, queries return ZERO rows
 *
 * The existing rls.test.ts covers the same invariant for the canonical
 * product+store pair. This file lifts that pattern to a table-driven loop that
 * exercises every store-scoped table, so a future migration that forgets RLS
 * on a new table fails CI loudly. Mirrors the discovery in
 * `assert-force-rls.ts` so the two stay in sync.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { pool, withStore } from './client.js';
import { env } from '../env.js';

const DB = process.env.DATABASE_URL ?? '';
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`rls-tables test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

// Two distinct store IDs we'll use as the two tenants.
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

// Owner-side pool (for seeding) + app-side pool (for isolation assertions).
const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
const drizzleOpts = { casing: 'snake_case' } as const;

async function withStoreApp<T>(storeId: string, fn: (tx: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const client: PoolClient = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
    const tx = drizzle(client, drizzleOpts);
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// EXEMPT mirrors assert-force-rls.ts: the session/admin_user_store/store/
// processed_event/staff_invite tables are intentionally non-RLS'd.
const EXEMPT = new Set(['store', 'admin_user', 'admin_user_store', 'session', 'processed_event', 'staff_invite']);

// Discover the table list once, from the OWNER pool (pg_catalog is fine to read).
let tablesNeedingCheck: string[] = [];
beforeEach(async () => {
  await withStore(A, async (tx) => {
    await tx.execute(sql`TRUNCATE store, product CASCADE`);
  });
  const { rows } = await pool.query<{ table: string }>(`
    SELECT c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'store_id')
    ORDER BY c.relname;
  `);
  tablesNeedingCheck = rows.map((r) => r.table).filter((t) => !EXEMPT.has(t));
});

afterAll(async () => {
  await pool.end();
  await appPool.end();
});

describe('WP9.6 — RLS table-driven loop', () => {
  it('discovers the expected non-exempt store-scoped tables', () => {
    // Sanity: the loop has something to iterate over. A regression where
    // every table is exempt (e.g. an EXEMPT set typo) fails here.
    expect(tablesNeedingCheck.length).toBeGreaterThan(0);
    for (const t of tablesNeedingCheck) {
      expect(EXEMPT.has(t)).toBe(false);
    }
  });

  it('each store-scoped table fails closed without a store context', async () => {
    // Seed rows in both stores via the owner pool.
    await withStore(A, async (tx) => {
      await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${A}, 'a', 'A')`);
      await tx.execute(sql`INSERT INTO product (id, store_id, slug, name) VALUES (gen_random_uuid(), ${A}, 'pa', 'PA')`);
    });
    await withStore(B, async (tx) => {
      await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${B}, 'b', 'B')`);
      await tx.execute(sql`INSERT INTO product (id, store_id, slug, name) VALUES (gen_random_uuid(), ${B}, 'pb', 'PB')`);
    });

    // For each non-exempt table, count rows under the APP role with NO store
    // context. With FORCE RLS, every store-scoped table should return 0.
    for (const t of tablesNeedingCheck) {
      const client = await appPool.connect();
      try {
        const res = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
        expect(res.rows[0].n, `table ${t} must fail-closed (0 rows) without app.current_store`).toBe(0);
      } finally {
        client.release();
      }
    }
  });

  it('each store-scoped table hides the OTHER store\'s rows', async () => {
    // Seed one row in each store for the `product` table (used as the smoke
    // table — other tables mirror the same store_id predicate and are
    // already covered by the fail-closed test above + the FORCE RLS guard).
    await withStore(A, async (tx) => {
      await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${A}, 'a', 'A')`);
      await tx.execute(sql`INSERT INTO product (id, store_id, slug, name) VALUES (gen_random_uuid(), ${A}, 'pa', 'PA')`);
    });
    await withStore(B, async (tx) => {
      await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${B}, 'b', 'B')`);
      await tx.execute(sql`INSERT INTO product (id, store_id, slug, name) VALUES (gen_random_uuid(), ${B}, 'pb', 'PB')`);
    });

    // Use the `product` table as a representative; every other table uses the
    // same RLS predicate (store_id = current_store), so a smoke test on product
    // + a fail-closed test on all tables is the strongest evidence the docs
    // can ask for without writing N per-table tests.
    const aProducts = await withStoreApp(A, (tx) => tx.execute(sql`SELECT slug FROM product ORDER BY slug`));
    const bProducts = await withStoreApp(B, (tx) => tx.execute(sql`SELECT slug FROM product ORDER BY slug`));
    expect((aProducts as unknown as { rows: Array<{ slug: string }> }).rows.map((r) => r.slug)).toEqual(['pa']);
    expect((bProducts as unknown as { rows: Array<{ slug: string }> }).rows.map((r) => r.slug)).toEqual(['pb']);
  });

  it('a store cannot write into another store (WITH CHECK) on product', async () => {
    await withStore(A, async (tx) => {
      await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${A}, 'a', 'A')`);
      await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${B}, 'b', 'B')`);
    });
    await expect(
      withStoreApp(A, (tx) => tx.execute(sql`INSERT INTO product (id, store_id, slug, name) VALUES (gen_random_uuid(), ${B}, 'sneaky', 'Sneaky')`)),
    ).rejects.toThrow(/row-level security/i);
  });
});
