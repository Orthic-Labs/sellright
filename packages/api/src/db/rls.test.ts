import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from './client.js';
import { product, store } from './schema.js';

/**
 * Tenant-isolation contract (RLS). Proves at the DB layer — not in app code —
 * that a request scoped to store A can never see or touch store B's rows.
 * Requires migrations applied to DATABASE_URL. Runs as the (non-superuser) app
 * role, so FORCE ROW LEVEL SECURITY applies to it.
 */
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

async function wipe() {
  // TRUNCATE is table-level (not RLS-gated) — needs a store context only to satisfy the session.
  await withStore(A, async (tx) => {
    await tx.execute(sql`TRUNCATE store, product CASCADE`);
  });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('RLS tenant isolation', () => {
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

  it('a store sees only its own rows', async () => {
    await seedBothStores();
    const aProducts = await withStore(A, (tx) => tx.select().from(product));
    expect(aProducts).toHaveLength(1);
    expect(aProducts[0]?.slug).toBe('prod-a');

    const aStores = await withStore(A, (tx) => tx.select().from(store));
    expect(aStores).toHaveLength(1);
    expect(aStores[0]?.slug).toBe('store-a');
  });

  it("a store cannot read another store's row even by id", async () => {
    await seedBothStores();
    const leaked = await withStore(A, (tx) =>
      tx.select().from(product).where(eq(product.slug, 'prod-b')),
    );
    expect(leaked).toHaveLength(0);
  });

  it('a store cannot write into another store (WITH CHECK)', async () => {
    await seedBothStores();
    await expect(
      withStore(A, (tx) =>
        tx.insert(product).values({ storeId: B, slug: 'sneaky', name: 'Sneaky A->B' }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('fails closed when no store context is set (zero rows, no error)', async () => {
    await seedBothStores();
    const client = await pool.connect();
    try {
      // No app.current_store set on this connection.
      const res = await client.query('SELECT count(*)::int AS n FROM product');
      expect(res.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });
});
