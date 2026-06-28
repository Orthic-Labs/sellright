import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from './client.js';
import { product, store } from './schema.js';
import { env } from '../env.js';
import {
  RLS_STORE_A as A,
  RLS_STORE_B as B,
  assertTestDatabase,
  createStoreAppRunner,
  expectRlsRejection,
} from './rls-test-utils.js';

/**
 * Tenant-isolation contract (RLS). Proves at the DB layer — not in app code —
 * that a request scoped to store A can never see or touch store B's rows.
 *
 * Two pools:
 *   ownerPool  (pool from client.ts, DATABASE_URL)           — seeding + wipe
 *   appPool    (DATABASE_URL_NONOWNER, or DATABASE_URL)       — isolation assertions
 *
 * In CI, DATABASE_URL = owner role (superuser), DATABASE_URL_NONOWNER = app role
 * (NOSUPERUSER NOBYPASSRLS). Tests exercise real RLS only when both differ.
 *
 * Requires migrations applied to DATABASE_URL. Refuses to run against anything
 * but a dedicated *_test database — TRUNCATE would wipe real data.
 */
const DB = process.env.DATABASE_URL ?? '';
assertTestDatabase(DB, 'RLS test');

// App-role pool: exercises FORCE ROW LEVEL SECURITY. Falls back to owner pool
// when DATABASE_URL_NONOWNER is not set (single-role dev setup).
const appPoolUrl = env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL;
const appPool = new Pool({ connectionString: appPoolUrl });
const drizzleOpts = { schema: { product, store }, casing: 'snake_case' } as const;
const withStoreApp = createStoreAppRunner(appPool, drizzleOpts);

// Wipe uses the owner pool (needs TRUNCATE on store, which app role may not have for writes)
async function wipe() {
  await withStore(A, async (tx) => {
    await tx.execute(sql`TRUNCATE store, product CASCADE`);
  });
}

// Seed uses the owner pool (INSERT on store is revoked from app role in production)
async function seedBothStores() {
  await withStore(A, async (tx) => {
    await tx.insert(store).values({ id: A, slug: 'store-a', name: 'Store A' });
    await tx.insert(product).values({ storeId: A, slug: 'prod-a', name: 'Product A' });
  });
  await withStore(B, async (tx) => {
    await tx.insert(store).values({ id: B, slug: 'store-b', name: 'Store B' });
    await tx.insert(product).values({ storeId: B, slug: 'prod-b', name: 'Product B' });
  });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await pool.end();
  await appPool.end();
});

describe('RLS tenant isolation', () => {
  it('a store sees only its own rows', async () => {
    await seedBothStores();
    const aProducts = await withStoreApp(A, (tx) => tx.select().from(product));
    expect(aProducts).toHaveLength(1);
    expect(aProducts[0]?.slug).toBe('prod-a');

    // store is the tenant registry (not RLS'd) — both stores are visible.
    const allStores = await withStoreApp(A, (tx) => tx.select().from(store));
    expect(allStores.length).toBeGreaterThanOrEqual(2);
  });

  it("a store cannot read another store's row even by id", async () => {
    await seedBothStores();
    const leaked = await withStoreApp(A, (tx) =>
      tx.select().from(product).where(eq(product.slug, 'prod-b')),
    );
    expect(leaked).toHaveLength(0);
  });

  it('a store cannot write into another store (WITH CHECK)', async () => {
    await seedBothStores();
    await expectRlsRejection(
      withStoreApp(A, (tx) =>
        tx.insert(product).values({ storeId: B, slug: 'sneaky', name: 'Sneaky A->B' }),
      ),
    );
  });

  it('fails closed when no store context is set (zero rows, no error)', async () => {
    await seedBothStores();
    const client = await appPool.connect();
    try {
      // No app.current_store set — FORCE RLS returns zero rows.
      const res = await client.query('SELECT count(*)::int AS n FROM product');
      expect(res.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });
});
