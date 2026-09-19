/** Disposable PostgreSQL tests; no live stores, tokens, credentials or production deployment. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { adminContent } from './admin-content.js';

// Keep the real route-level bearer/store/role checks, but replace the global
// session lookup. This suite tests tenant transactions, not the login implementation.
const principal = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../auth/admin-session.js', () => ({ resolveAdmin: async (token: string) => token === 'fixture-token' ? {
  email: 'fixture@example.test', stores: [{ storeId: '11111111-1111-4111-a111-111111111111', slug: 'blog-test', role: principal.role }],
} : null }));

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) throw new Error('blog protocol tests require a disposable *_test database');
const STORE = '11111111-1111-4111-a111-111111111111';
const OTHER = '22222222-2222-4222-a222-222222222222';
const ASSET = '33333333-3333-4333-a333-333333333333';
const app = new OpenAPIHono(); app.route('/', adminContent);
const auth = () => ({ authorization: 'Bearer fixture-token', 'x-store-slug': 'blog-test', 'content-type': 'application/json' });
const body = { title: 'Fixture article', slug: 'fixture-article', body: '<p>Documented fixture article.</p>', authorName: 'Fixture Editor', isPublished: false };

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE'); principal.role = 'owner';
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, 'blog-test', 'Blog Test', 'USD', '{}'::jsonb)`);
    await tx.execute(sql`INSERT INTO asset (id, store_id, type, path, width, height, alt) VALUES (${ASSET}, ${STORE}, 'image', 'blog-test/fixture.webp', 10, 10, 'Fixture image')`);
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });

async function create(key = 'fixture-create-1', override = {}) {
  return app.request('/v1/admin/blog', { method: 'POST', headers: { ...auth(), 'idempotency-key': key }, body: JSON.stringify({ ...body, ...override }) });
}
async function detail(id: string) {
  const response = await app.request(`/v1/admin/blog/${id}`, { headers: auth() });
  expect(response.status).toBe(200);
  return await response.json() as { id: string; seoRevision: string; seoContract: string; title: string; featuredAssetId: string | null; isPublished: boolean };
}
async function patchPost(id: string, patch: object) {
  return app.request(`/v1/admin/blog/${id}`, { method: 'PATCH', headers: auth(), body: JSON.stringify(patch) });
}

describe('blog conditional update and durable create contract', () => {
  it('advertises capabilities without claiming a deployed storefront', async () => {
    const response = await app.request('/v1/admin/blog', { headers: auth() });
    expect(await response.json()).toMatchObject({ seoContract: 'revision-v1', createContract: 'audit-receipt-v1', items: [] });
  });
  it('serializes competing conditional edits and rejects the stale request', async () => {
    const { id } = await (await create()).json() as { id: string };
    const first = await detail(id);
    const results = await Promise.all([
      patchPost(id, { title: 'Writer A', expectedRevision: first.seoRevision }),
      patchPost(id, { title: 'Writer B', expectedRevision: first.seoRevision }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const after = await detail(id);
    expect(['Writer A', 'Writer B']).toContain(after.title);
    expect(after.seoRevision).not.toBe(first.seoRevision);
  });
  it('does not permit a stale publication or rollback to overwrite another edit', async () => {
    const { id } = await (await create()).json() as { id: string };
    const baseline = await detail(id);
    expect((await patchPost(id, { title: 'New editor', expectedRevision: baseline.seoRevision })).status).toBe(200);
    expect((await patchPost(id, { isPublished: true, expectedRevision: baseline.seoRevision })).status).toBe(409);
    expect((await detail(id)).isPublished).toBe(false);
  });
  it('returns exactly one post for concurrent retries of the same create request', async () => {
    const results = await Promise.all([create(), create()]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const receipts = await Promise.all(results.map(r => r.json()));
    expect(receipts[0]).toEqual(receipts[1]);
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM blog_post');
    expect(rows[0].count).toBe(1);
  });
  it('does not reinterpret a reused key as a new payload', async () => {
    expect((await create()).status).toBe(200);
    expect((await create('fixture-create-1', { title: 'Different request' })).status).toBe(409);
  });
  it('retains the create receipt after deletion instead of recreating a post', async () => {
    const { id } = await (await create()).json() as { id: string };
    expect((await app.request(`/v1/admin/blog/${id}`, { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect((await create()).status).toBe(409);
  });
  it('does not rename an idempotent create to bypass a slug collision', async () => {
    expect((await create()).status).toBe(200);
    expect((await create('another-key')).status).toBe(409);
  });
  it('creates, changes and clears an owned featured-image reference', async () => {
    const { id } = await (await create('with-image', { featuredAssetId: ASSET })).json() as { id: string };
    const post = await detail(id); expect(post.featuredAssetId).toBe(ASSET);
    expect((await patchPost(id, { featuredAssetId: null, expectedRevision: post.seoRevision })).status).toBe(200);
    expect((await detail(id)).featuredAssetId).toBeNull();
  });
  it('rejects another stores asset even though its UUID is a valid foreign key', async () => {
    const foreign = '44444444-4444-4444-a444-444444444444';
    await withStore(OTHER, async tx => {
      await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${OTHER}, 'other-blog-test', 'Other', 'USD', '{}'::jsonb)`);
      await tx.execute(sql`INSERT INTO asset (id, store_id, type, path) VALUES (${foreign}, ${OTHER}, 'image', 'other-blog-test/x.webp')`);
    });
    expect((await create('foreign', { featuredAssetId: foreign })).status).toBe(404);
  });
  it('preserves bearer, store and read-only role gates', async () => {
    expect((await app.request('/v1/admin/blog')).status).toBe(401);
    expect((await app.request('/v1/admin/blog', { headers: { ...auth(), 'x-store-slug': 'other' } })).status).toBe(403);
    principal.role = 'read_only'; expect((await create()).status).toBe(403);
  });
  it('preserves existing future publish-date behavior', async () => {
    const publishDate = '2030-01-01T00:00:00.000Z';
    const { id } = await (await create('future', { publishDate })).json() as { id: string };
    const response = await app.request(`/v1/admin/blog/${id}`, { headers: auth() });
    const post = await response.json() as { publishDate: string; seoRevision: string };
    expect(post.publishDate).toBe(publishDate);
    expect((await patchPost(id, { publishDate: null, expectedRevision: post.seoRevision })).status).toBe(200);
  });
  it('rejects malformed keys and conditional revisions before effects', async () => {
    expect((await create('not a valid key')).status).toBe(400);
    const { id } = await (await create()).json() as { id: string };
    expect((await patchPost(id, { title: 'X', expectedRevision: 'not-a-revision' })).status).toBe(400);
  });
});
