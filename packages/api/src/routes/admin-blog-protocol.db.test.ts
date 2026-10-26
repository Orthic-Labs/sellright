/** Disposable PostgreSQL tests; no live stores, tokens, credentials or production deployment. */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
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
assertTestDatabase(DB, 'admin-blog-protocol.db.test.ts');
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
    const { rows } = await withStore(STORE, tx => tx.execute(sql`SELECT count(*)::int AS count FROM blog_post`));
    expect((rows[0] as { count: number }).count).toBe(1);
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
  it('offers read-only reconciliation of a specific store-scoped request', async () => {
    expect((await app.request('/v1/admin/blog/requests/missing', { headers: auth() })).status).toBe(404);
    const post = await (await create()).json() as { id: string; slug: string };
    const response = await app.request('/v1/admin/blog/requests/fixture-create-1', { headers: auth() });
    expect(response.status).toBe(200);
    const receipt = await response.json() as { requestHash: string };
    expect(receipt).toMatchObject({ id: post.id, slug: post.slug, storeId: STORE });
    expect(receipt.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await app.request('/v1/admin/blog/requests/fixture-create-1')).status).toBe(401);
  });
  it('rejects malformed keys and conditional revisions before effects', async () => {
    expect((await create('not a valid key')).status).toBe(400);
    const { id } = await (await create()).json() as { id: string };
    expect((await patchPost(id, { title: 'X', expectedRevision: 'not-a-revision' })).status).toBe(400);
  });
  it('rejects a duplicate slug with a clear 409 instead of silently suffixing it, with or without an idempotency key', async () => {
    expect((await create()).status).toBe(200);
    const res = await app.request('/v1/admin/blog', { method: 'POST', headers: auth(), body: JSON.stringify(body) });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('A blog post with slug \\"fixture-article\\" already exists');
    const { rows } = await withStore(STORE, tx => tx.execute(sql`SELECT count(*)::int AS count FROM blog_post`));
    expect((rows[0] as { count: number }).count).toBe(1);
  });
  it('derives the slug from the title when none is given, and lets a manual slug override it', async () => {
    const auto = await (await create('auto-slug', { slug: undefined, title: 'My First Post!' })).json() as { slug: string };
    expect(auto.slug).toBe('my-first-post');
    const manual = await (await create('manual-slug', { slug: 'Custom Slug', title: 'Other' })).json() as { slug: string };
    expect(manual.slug).toBe('custom-slug');
  });
  it('changes the slug on PATCH, rejects one already taken, and leaves an unchanged slug alone', async () => {
    const a = await (await create('slug-a', { slug: 'post-a' })).json() as { id: string };
    await create('slug-b', { slug: 'post-b' });
    expect((await patchPost(a.id, { slug: 'post-b' })).status).toBe(409);
    expect((await patchPost(a.id, { slug: 'post-a' , title: 'Renamed' })).status).toBe(200);
    expect((await patchPost(a.id, { slug: 'post-c' })).status).toBe(200);
    expect((await (await app.request(`/v1/admin/blog/${a.id}`, { headers: auth() })).json() as { slug: string }).slug).toBe('post-c');
    expect((await patchPost(a.id, { slug: '---' })).status).toBe(400);
  });
  it('never defaults the author to the staff email', async () => {
    const { id } = await (await create('no-author', { authorName: undefined })).json() as { id: string };
    const post = await (await app.request(`/v1/admin/blog/${id}`, { headers: auth() })).json() as { authorName: string };
    expect(post.authorName).toBe('');
  });
  it('auto-generates a <=160 char excerpt when blank, computes 225wpm reading time, and keeps a supplied excerpt', async () => {
    const long = `<p>${'lorem '.repeat(500)}</p>`;
    const { id } = await (await create('excerpt', { body: long, excerpt: '  ' })).json() as { id: string };
    const post = await (await app.request(`/v1/admin/blog/${id}`, { headers: auth() })).json() as { excerpt: string; readingTime: number; seoRevision: string };
    expect(post.excerpt.length).toBeLessThanOrEqual(160);
    expect(post.excerpt.endsWith('lorem...')).toBe(true);
    expect(post.readingTime).toBe(2); // 500 words / 225 = 2.2
    expect((await patchPost(id, { excerpt: 'Hand written' })).status).toBe(200);
    expect((await patchPost(id, { body: long })).status).toBe(200);
    expect((await (await app.request(`/v1/admin/blog/${id}`, { headers: auth() })).json() as { excerpt: string }).excerpt).toBe('Hand written');
    expect((await patchPost(id, { excerpt: '', body: long })).status).toBe(200);
    expect((await (await app.request(`/v1/admin/blog/${id}`, { headers: auth() })).json() as { excerpt: string }).excerpt.endsWith('lorem...')).toBe(true);
  });
  it('lists newest-created first with read time and tags, and the detail carries the featured image path', async () => {
    const first = await (await create('first', { slug: 'first', tags: [' a ', '', 'b'] })).json() as { id: string };
    await new Promise(r => setTimeout(r, 15));
    const second = await (await create('second', { slug: 'second', featuredAssetId: ASSET })).json() as { id: string };
    const list = await (await app.request('/v1/admin/blog', { headers: auth() })).json() as { items: { id: string; tags: string[]; readingTime: number; createdAt: string }[] };
    expect(list.items.map(i => i.id)).toEqual([second.id, first.id]);
    expect(list.items[1]).toMatchObject({ tags: ['a', 'b'], readingTime: 1 });
    expect(list.items[0]!.createdAt).toMatch(/^\d{4}-/);
    const detailRow = await (await app.request(`/v1/admin/blog/${second.id}`, { headers: auth() })).json() as { featuredAssetPath: string | null; seoRevision: string };
    expect(detailRow.featuredAssetPath).toBe('blog-test/fixture.webp');
    // The display-only path never enters the revision: a no-op revision read still matches the stored row.
    expect((await patchPost(second.id, { title: 'Same revision', expectedRevision: detailRow.seoRevision })).status).toBe(200);
  });
  it('sanitises on write with the rich allowlist: an infographic post survives create -> read -> edit unchanged', async () => {
    const rich = '<div class="chart" data-k="1" style="color:red"><svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="5" height="5" fill="#b87333"></rect></svg><table><tbody><tr><td colspan="2">x</td></tr></tbody></table></div><p>Tail <a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></p>';
    const { id } = await (await create('rich', { body: rich })).json() as { id: string };
    const read = await (await app.request(`/v1/admin/blog/${id}`, { headers: auth() })).json() as { bodyHtml: string };
    expect(read.bodyHtml).toBe(rich);
    expect((await patchPost(id, { body: read.bodyHtml })).status).toBe(200);
    expect((await (await app.request(`/v1/admin/blog/${id}`, { headers: auth() })).json() as { bodyHtml: string }).bodyHtml).toBe(rich);
  });
});
