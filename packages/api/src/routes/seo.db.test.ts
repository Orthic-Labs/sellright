/**
 * SEO-1 route-level tests (DB-required — .db.test.ts runs under the `db`
 * vitest project only). Exercises the public /v1/shop/seo/* surface end to
 * end: store-scoped sitemaps/robots/JSON-LD, live stock in the Product
 * JSON-LD endpoint, and cross-store isolation. Mirrors feeds.db.test.ts's
 * seeding style.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'seo.db.test.ts');

const STORE_A = 'aaaaaaa1-1111-1111-1111-111111111111';
const STORE_B = 'bbbbbbb2-2222-2222-2222-222222222222';
const app = createApp();
const get = (path: string, slug = 'seo-a') => app.request(path, { headers: { 'x-store-slug': slug } });

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  // resolveStoreForRequest caches by slug for 60s (store-context.ts) — every
  // test here reuses the same slugs ('seo-a'/'seo-b') across re-seeds with
  // different config, so a stale cached row from an earlier test would
  // otherwise leak in. Flush unconditionally, matching contact.db.test.ts /
  // cart-hardening.db.test.ts's convention.
  invalidateStoreCache();
}

async function seedStore(id: string, slug: string, config: Record<string, unknown> | null): Promise<void> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $3, 'USD', $4::jsonb)`, [id, slug, `${slug} store`, JSON.stringify(config ?? {})]);
  invalidateStoreCache(slug);
}

async function seedProduct(storeId: string, slug: string, opts: { status?: 'active' | 'draft'; onHand?: number } = {}): Promise<string> {
  return withStore(storeId, async (tx) => {
    const p = await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, description, status) VALUES (gen_random_uuid(), ${storeId}, ${slug}, ${'Name ' + slug}, 'A description', ${opts.status ?? 'active'}) RETURNING id`);
    const productId = (p.rows[0] as { id: string }).id;
    const v = await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, sale_price, enabled) VALUES (gen_random_uuid(), ${storeId}, ${productId}, ${slug.toUpperCase() + '-SKU'}, 'Standard', 2999, 1999, true) RETURNING id`);
    const variantId = (v.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${variantId}, ${storeId}, ${opts.onHand ?? 0}, 0)`);
    return variantId;
  });
}

async function seedCollection(storeId: string, slug: string, published: boolean): Promise<void> {
  await withStore(storeId, (tx) => tx.execute(sql`INSERT INTO collection (id, store_id, slug, name, published) VALUES (gen_random_uuid(), ${storeId}, ${slug}, ${'Collection ' + slug}, ${published})`));
}

async function seedBlogPost(storeId: string, slug: string, opts: { isPublished?: boolean; publishDate?: string | null } = {}): Promise<void> {
  await withStore(storeId, (tx) => tx.execute(sql`INSERT INTO blog_post (id, store_id, slug, title, is_published, publish_date) VALUES (gen_random_uuid(), ${storeId}, ${slug}, ${'Post ' + slug}, ${opts.isPublished ?? true}, ${opts.publishDate ?? null})`));
}

describe('GET /v1/shop/seo/*', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('503s every siteUrl-dependent endpoint when the store has no siteUrl/storefrontUrl configured', async () => {
    await seedStore(STORE_A, 'seo-a', {});
    for (const path of ['/v1/shop/seo/sitemap.xml', '/v1/shop/seo/sitemap-main.xml', '/v1/shop/seo/sitemap-products.xml', '/v1/shop/seo/sitemap-collections.xml', '/v1/shop/seo/sitemap-blog.xml', '/v1/shop/seo/robots.txt', '/v1/shop/seo/jsonld/organization']) {
      const res = await get(path);
      expect(res.status, path).toBe(503);
    }
  });

  it('sitemap index links the four sibling sitemap files at the configured siteUrl', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com' } });
    const xml = await (await get('/v1/shop/seo/sitemap.xml')).text();
    expect(xml).toContain('<loc>https://a.example.com/sitemap-main.xml</loc>');
    expect(xml).toContain('<loc>https://a.example.com/sitemap-products.xml</loc>');
    expect(xml).toContain('<loc>https://a.example.com/sitemap-collections.xml</loc>');
    expect(xml).toContain('<loc>https://a.example.com/sitemap-blog.xml</loc>');
  });

  it('sitemap-main.xml uses configured staticPaths, defaulting to just "/"', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com' } });
    expect(await (await get('/v1/shop/seo/sitemap-main.xml')).text()).toContain('<loc>https://a.example.com/</loc>');

    await pool.query(`UPDATE store SET config = config || '{"seo":{"siteUrl":"https://a.example.com","staticPaths":["/","/about/"]}}'::jsonb WHERE id = $1`, [STORE_A]);
    invalidateStoreCache('seo-a');
    const xml = await (await get('/v1/shop/seo/sitemap-main.xml')).text();
    expect(xml).toContain('<loc>https://a.example.com/about/</loc>');
  });

  it('sitemap-products.xml lists only active, non-deleted products, store-scoped, with lastmod', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com' } });
    await seedStore(STORE_B, 'seo-b', { seo: { siteUrl: 'https://b.example.com' } });
    await seedProduct(STORE_A, 'live-widget');
    await seedProduct(STORE_A, 'draft-widget', { status: 'draft' });
    await seedProduct(STORE_B, 'other-store-widget');

    const xml = await (await get('/v1/shop/seo/sitemap-products.xml')).text();
    expect(xml).toContain('<loc>https://a.example.com/products/live-widget/</loc>');
    expect(xml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T/);
    expect(xml).not.toContain('draft-widget');
    expect(xml).not.toContain('other-store-widget');
  });

  it('sitemap-collections.xml lists only published collections', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com' } });
    await seedCollection(STORE_A, 'published-col', true);
    await seedCollection(STORE_A, 'draft-col', false);
    const xml = await (await get('/v1/shop/seo/sitemap-collections.xml')).text();
    expect(xml).toContain('<loc>https://a.example.com/collections/published-col/</loc>');
    expect(xml).not.toContain('draft-col');
  });

  it('sitemap-blog.xml lists only published, non-future-dated posts', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com' } });
    await seedBlogPost(STORE_A, 'live-post', { isPublished: true });
    await seedBlogPost(STORE_A, 'unpublished-post', { isPublished: false });
    await seedBlogPost(STORE_A, 'future-post', { isPublished: true, publishDate: '2999-01-01T00:00:00Z' });
    const xml = await (await get('/v1/shop/seo/sitemap-blog.xml')).text();
    expect(xml).toContain('<loc>https://a.example.com/blog/live-post/</loc>');
    expect(xml).not.toContain('unpublished-post');
    expect(xml).not.toContain('future-post');
  });

  it('robots.txt renders the configured disallow list and a Sitemap line, never Crawl-delay', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com', robotsDisallow: ['checkout', 'account'] } });
    const txt = await (await get('/v1/shop/seo/robots.txt')).text();
    expect(txt).toContain('Disallow: /checkout');
    expect(txt).toContain('Disallow: /account');
    expect(txt).toContain('Sitemap: https://a.example.com/sitemap.xml');
    expect(txt).not.toMatch(/crawl-delay/i);
  });

  it('jsonld/organization returns Organization + WebSite when configured', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com', organization: { name: 'Acme Co' } } });
    const body = await (await get('/v1/shop/seo/jsonld/organization')).json() as { items: Array<{ '@type': string; name: string }> };
    const types = body.items.map((i) => i['@type']);
    expect(types).toEqual(expect.arrayContaining(['Organization', 'WebSite']));
    expect(body.items.every((i) => i.name === 'Acme Co')).toBe(true);
  });

  it('jsonld/products/{slug}: price and availability are live — a stock update flips it on the very next request', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com' } });
    const variantId = await seedProduct(STORE_A, 'flip-widget', { onHand: 0 });

    const before = await (await get('/v1/shop/seo/jsonld/products/flip-widget')).json() as { offers: { availability: string; price: string } };
    expect(before.offers.availability).toBe('https://schema.org/OutOfStock');
    expect(before.offers.price).toBe('19.99'); // sale_price wins over price (default 'preorder' rule: positive salePrice)

    await withStore(STORE_A, (tx) => tx.execute(sql`UPDATE stock SET on_hand = 5 WHERE variant_id = ${variantId}`));
    const after = await (await get('/v1/shop/seo/jsonld/products/flip-widget')).json() as { offers: { availability: string } };
    expect(after.offers.availability).toBe('https://schema.org/InStock');
  });

  it('jsonld/products/{slug} 404s for an unknown or cross-store slug', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com' } });
    await seedStore(STORE_B, 'seo-b', { seo: { siteUrl: 'https://b.example.com' } });
    await seedProduct(STORE_B, 'store-b-only');
    expect((await get('/v1/shop/seo/jsonld/products/nope')).status).toBe(404);
    expect((await get('/v1/shop/seo/jsonld/products/store-b-only')).status).toBe(404); // store-scoped from seo-a
  });

  it('indexnow-key.txt 404s when unconfigured and serves the raw key when configured', async () => {
    await seedStore(STORE_A, 'seo-a', { seo: { siteUrl: 'https://a.example.com' } });
    expect((await get('/v1/shop/seo/indexnow-key.txt')).status).toBe(404);

    await pool.query(`UPDATE store SET config = config || '{"seo":{"indexNow":{"key":"abcdef0123456789"}}}'::jsonb WHERE id = $1`, [STORE_A]);
    invalidateStoreCache('seo-a');
    const res = await get('/v1/shop/seo/indexnow-key.txt');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abcdef0123456789');
  });
});
