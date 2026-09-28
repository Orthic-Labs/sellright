/**
 * `loadCouponMatchContext` is the one DB-touching half of the native-coupon-
 * condition work (coupon.ts itself is pure) — proves it reads a
 * product's native `tags` and native `collection_product` memberships
 * correctly, the two primitives that replaced `metafields.facetValueIds`.
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { loadCouponMatchContext } from './coupon-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`coupon-context test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'f0000000-0000-0000-0000-00000000f002';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
async function seedStore() {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'coupon-ctx-test', 'Coupon Ctx Test', 'USD') ON CONFLICT (id) DO NOTHING`, [STORE]);
}

describe('loadCouponMatchContext', () => {
  beforeEach(async () => { await wipe(); await seedStore(); });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('reads native product.tags and collection_product memberships (no facet lookup)', async () => {
    const ids = await withStore(STORE, async (tx) => {
      const p1 = (await tx.execute(sql`INSERT INTO product (store_id, slug, name, tags) VALUES (${STORE}, 'edc-knife', 'EDC Knife', ARRAY['edc','folder']) RETURNING id`)).rows[0] as { id: string };
      const p2 = (await tx.execute(sql`INSERT INTO product (store_id, slug, name, tags) VALUES (${STORE}, 'plain-widget', 'Plain Widget', NULL) RETURNING id`)).rows[0] as { id: string };
      const col = (await tx.execute(sql`INSERT INTO collection (store_id, slug, name) VALUES (${STORE}, 'knives', 'Knives') RETURNING id`)).rows[0] as { id: string };
      await tx.execute(sql`INSERT INTO collection_product (store_id, collection_id, product_id) VALUES (${STORE}, ${col.id}, ${p1.id})`);
      return { p1: p1.id, p2: p2.id, col: col.id };
    });

    const facts = await withStore(STORE, (tx) => loadCouponMatchContext(tx, [ids.p1, ids.p2]));

    expect(facts.get(ids.p1)).toEqual({ productId: ids.p1, tags: ['edc', 'folder'], collectionIds: [ids.col] });
    expect(facts.get(ids.p2)).toEqual({ productId: ids.p2, tags: [], collectionIds: [] });
  });

  it('returns an empty map for an empty product id list (no query issued)', async () => {
    const facts = await withStore(STORE, (tx) => loadCouponMatchContext(tx, []));
    expect(facts.size).toBe(0);
  });

  it('omits a product id that does not exist (deleted between cart read and coupon eval)', async () => {
    const facts = await withStore(STORE, (tx) => loadCouponMatchContext(tx, ['00000000-0000-0000-0000-000000000000']));
    expect(facts.size).toBe(0);
  });
});
