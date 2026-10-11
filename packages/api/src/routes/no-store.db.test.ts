/**
 * Every stock-bearing (and every other non-exempt) API response is `private, no-store`, success or error.
 * DB-required (runs under the `db` vitest project). The exception list itself is covered by ../cache-policy.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { env } from '../env.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'no-store.db.test.ts');

const STORE = 'eeeeeee5-5555-5555-5555-555555555555';
const SLUG = 'nostore-a';
const app = createApp();
const req = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { 'x-store-slug': SLUG, ...(init.headers as Record<string, string> | undefined) } });

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seed(): Promise<{ productSlug: string }> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'No Store', 'USD', '{}'::jsonb)`, [STORE, SLUG]);
  await withStore(STORE, async (tx) => {
    const p = await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, description, status) VALUES (gen_random_uuid(), ${STORE}, 'ns-tee', 'NS Tee', 'x', 'active') RETURNING id`);
    const productId = (p.rows[0] as { id: string }).id;
    const v = await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, enabled) VALUES (gen_random_uuid(), ${STORE}, ${productId}, 'NS-1', 'Std', 1999, true) RETURNING id`);
    const variantId = (v.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${variantId}, ${STORE}, 4, 0)`);
  });
  return { productSlug: 'ns-tee' };
}

describe('API responses are private, no-store', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('catalog list, product, product stock, cart read, checkout error, shop config, feed, 404', async () => {
    const { productSlug } = await seed();
    const created = await req('/v1/shop/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(created.headers.get('cache-control'), 'cart create').toBe('private, no-store');
    const token = ((await created.json()) as { token?: string; cart?: { token?: string } }).token
      ?? 'unknown-cart-token';

    const table: Array<{ name: string; path: string; init?: RequestInit; status?: number }> = [
      { name: 'catalog list', path: '/v1/shop/catalog/products', status: 200 },
      { name: 'product', path: `/v1/shop/catalog/products/${productSlug}`, status: 200 },
      { name: 'product stock', path: `/v1/shop/catalog/products/${productSlug}/stock`, status: 200 },
      { name: 'product stock, unknown slug (error)', path: '/v1/shop/catalog/products/nope/stock' },
      { name: 'cart read', path: `/v1/shop/cart/${token}`, status: 200 },
      { name: 'cart read, unknown token (error)', path: '/v1/shop/cart/does-not-exist' },
      { name: 'checkout error path', path: '/v1/shop/checkout', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } },
      { name: 'shop config', path: '/v1/shop/config' },
      { name: 'merchant feed', path: '/v1/shop/feeds/google', status: 200 },
      { name: 'product JSON-LD (live stock)', path: `/v1/shop/seo/jsonld/products/${productSlug}` },
      { name: '404', path: '/v1/definitely/not/a/route', status: 404 },
    ];
    for (const row of table) {
      const res = await req(row.path, row.init);
      if (row.status) expect(res.status, row.name).toBe(row.status);
      expect(res.headers.get('cache-control'), `${row.name} (${res.status})`).toBe('private, no-store');
      expect(res.headers.get('cdn-cache-control'), row.name).toBeNull();
    }
  });
});
