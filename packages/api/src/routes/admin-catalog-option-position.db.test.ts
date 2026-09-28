/**
 * Merchant-controlled ordering for product option groups and values
 * (migration 0080): new groups/values are appended at the next position,
 * GET/storefront read back in position order (never alphabetical), and the
 * reorder endpoints apply atomically and reject anything that isn't an
 * exact permutation of the current set (partial list, foreign id, or a
 * duplicate) — see routes/admin-catalog.ts's two `/reorder` routes.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminCatalog } from './admin-catalog.js';
import { catalog } from './catalog.js';

const dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.slice(1));
if (!dbName.endsWith('_test')) throw new Error('Option-position tests require a *_test database');

const STORE = 'abcdabcd-4444-4444-8444-444444444444';
const OWNER = 'abcdabcd-5555-4555-8555-555555555555';
const READ_ONLY = 'abcdabcd-6666-4666-8666-666666666666';
const SLUG = 'option-position';
const app = new OpenAPIHono();
app.route('/', adminCatalog);
app.route('/', catalog);
const headers = { 'x-store-slug': SLUG, 'content-type': 'application/json' };
let ownerToken: string;
let readOnlyToken: string;

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  await pool.query('INSERT INTO store (id, slug, name) VALUES ($1, $2, $2)', [STORE, SLUG]);
  await pool.query('INSERT INTO admin_user (id, email) VALUES ($1, $2), ($3, $4)', [OWNER, 'owner@optpos.test', READ_ONLY, 'viewer@optpos.test']);
  await pool.query('INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3), ($4, $2, $5)', [OWNER, STORE, 'owner', READ_ONLY, 'read_only']);
  ownerToken = await createAdminSession(OWNER);
  readOnlyToken = await createAdminSession(READ_ONLY);
  invalidateStoreCache();
});
afterAll(() => pool.end());

function admin(method: string, path: string, body?: unknown, token = ownerToken) {
  return app.request(path, { method, headers: { ...headers, authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
}
function shop(path: string) {
  return app.request(path, { headers: { 'x-store-slug': SLUG } });
}

async function createActiveProductWithVariant(sku: string) {
  const p = await admin('POST', '/v1/admin/products', { name: `Fixture ${sku}`, status: 'active' });
  const { id: productId, slug } = (await p.json()) as { id: string; slug: string };
  const v = await admin('POST', `/v1/admin/products/${productId}/variants`, { sku, name: sku, price: 1000 });
  const { id: variantId } = (await v.json()) as { id: string };
  return { productId, slug, variantId };
}

describe('option group/value position — create appends, GET reads in order', () => {
  it('new groups and values get sequential positions, never alphabetical', async () => {
    const { productId } = await createActiveProductWithVariant('POS-1');
    const color = await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Zebra Color', values: ['Red', 'Blue'] });
    expect(color.status).toBe(200);
    const size = await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Apple Size' });
    expect(size.status).toBe(200);
    const { id: sizeGroupId } = (await size.json()) as { id: string };
    await admin('POST', `/v1/admin/option-groups/${sizeGroupId}/options`, { value: 'Large' });
    await admin('POST', `/v1/admin/option-groups/${sizeGroupId}/options`, { value: 'Small' });

    const res = await admin('GET', `/v1/admin/products/${productId}/options`);
    const { groups } = (await res.json()) as { groups: { id: string; name: string; position: number; options: { value: string; position: number }[] }[] };
    // 'Apple Size' was created AFTER 'Zebra Color' — alphabetical would flip
    // this; position (creation/append order) must not.
    expect(groups.map((g) => g.name)).toEqual(['Zebra Color', 'Apple Size']);
    expect(groups.map((g) => g.position)).toEqual([0, 1]);
    expect(groups[0]!.options.map((o) => o.value)).toEqual(['Red', 'Blue']);
    expect(groups[0]!.options.map((o) => o.position)).toEqual([0, 1]);
    // 'Large' before 'Small' — alphabetical would also flip this.
    expect(groups[1]!.options.map((o) => o.value)).toEqual(['Large', 'Small']);
  });
});

describe('option group reorder', () => {
  it('applies atomically and is reflected on the next GET', async () => {
    const { productId } = await createActiveProductWithVariant('POS-2');
    const g1 = await (await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Color' })).json() as { id: string };
    const g2 = await (await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Size' })).json() as { id: string };

    const reordered = await admin('PUT', `/v1/admin/products/${productId}/option-groups/reorder`, { order: [g2.id, g1.id] });
    expect(reordered.status).toBe(200);

    const res = await admin('GET', `/v1/admin/products/${productId}/options`);
    const { groups } = (await res.json()) as { groups: { id: string; name: string }[] };
    expect(groups.map((g) => g.id)).toEqual([g2.id, g1.id]);
  });

  it('rejects a partial list, a foreign id, and a duplicate — never silently drops or smuggles', async () => {
    const { productId } = await createActiveProductWithVariant('POS-3');
    const g1 = await (await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Color' })).json() as { id: string };
    const g2 = await (await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Size' })).json() as { id: string };
    const other = await createActiveProductWithVariant('POS-3-OTHER');
    const foreign = await (await admin('POST', `/v1/admin/products/${other.productId}/option-groups`, { name: 'Material' })).json() as { id: string };

    expect((await admin('PUT', `/v1/admin/products/${productId}/option-groups/reorder`, { order: [g1.id] })).status).toBe(400);
    expect((await admin('PUT', `/v1/admin/products/${productId}/option-groups/reorder`, { order: [g1.id, g2.id, foreign.id] })).status).toBe(400);
    expect((await admin('PUT', `/v1/admin/products/${productId}/option-groups/reorder`, { order: [g1.id, g1.id] })).status).toBe(400);

    // Untouched after every rejected attempt.
    const res = await admin('GET', `/v1/admin/products/${productId}/options`);
    const { groups } = (await res.json()) as { groups: { id: string }[] };
    expect(groups.map((g) => g.id)).toEqual([g1.id, g2.id]);
  });

  it('a read-only role cannot reorder', async () => {
    const { productId } = await createActiveProductWithVariant('POS-4');
    const g1 = await (await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Color' })).json() as { id: string };
    const res = await admin('PUT', `/v1/admin/products/${productId}/option-groups/reorder`, { order: [g1.id] }, readOnlyToken);
    expect(res.status).toBe(403);
  });
});

describe('option value reorder within a group', () => {
  it('applies atomically and is reflected on the next GET', async () => {
    const { productId } = await createActiveProductWithVariant('POS-5');
    const group = await (await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Color', values: ['Red', 'Blue'] })).json() as { id: string };
    const before = await (await admin('GET', `/v1/admin/products/${productId}/options`)).json() as { groups: { id: string; options: { id: string; value: string }[] }[] };
    const [red, blue] = before.groups[0]!.options;

    const reordered = await admin('PUT', `/v1/admin/option-groups/${group.id}/options/reorder`, { order: [blue!.id, red!.id] });
    expect(reordered.status).toBe(200);

    const after = await (await admin('GET', `/v1/admin/products/${productId}/options`)).json() as { groups: { options: { value: string }[] }[] };
    expect(after.groups[0]!.options.map((o) => o.value)).toEqual(['Blue', 'Red']);
  });
});

describe('storefront product detail honors merchant order (never alphabetical)', () => {
  it('reflects a reorder immediately, for both groups and values', async () => {
    const { productId, slug, variantId } = await createActiveProductWithVariant('POS-6');
    const color = await (await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Zebra Color', values: ['Red', 'Blue'] })).json() as { id: string };
    const size = await (await admin('POST', `/v1/admin/products/${productId}/option-groups`, { name: 'Apple Size', values: ['Large', 'Small'] })).json() as { id: string };
    const optsRes = await (await admin('GET', `/v1/admin/products/${productId}/options`)).json() as { groups: { id: string; options: { id: string; value: string }[] }[] };
    const colorGroup = optsRes.groups.find((g) => g.id === color.id)!;
    const sizeGroup = optsRes.groups.find((g) => g.id === size.id)!;
    const allOptionIds = [...colorGroup.options, ...sizeGroup.options].map((o) => o.id);
    expect((await admin('PUT', `/v1/admin/variants/${variantId}/options`, { optionIds: allOptionIds })).status).toBe(200);

    // Pre-reorder: creation order is Zebra Color, then Apple Size.
    let detail = await (await shop(`/v1/shop/catalog/products/${slug}`)).json() as { variants: { options: { name: string; group: { name: string } }[] }[] };
    expect(detail.variants[0]!.options.map((o) => o.group.name)).toEqual(['Zebra Color', 'Zebra Color', 'Apple Size', 'Apple Size']);

    // Reorder groups (Apple Size first) and values within Color (Blue first)
    // — alphabetical-by-name would have already put Apple Size first and
    // never move Blue ahead of Red, so this proves the merchant's explicit
    // order wins, not a naming coincidence.
    expect((await admin('PUT', `/v1/admin/products/${productId}/option-groups/reorder`, { order: [size.id, color.id] })).status).toBe(200);
    const blueId = colorGroup.options.find((o) => o.value === 'Blue')!.id;
    const redId = colorGroup.options.find((o) => o.value === 'Red')!.id;
    expect((await admin('PUT', `/v1/admin/option-groups/${color.id}/options/reorder`, { order: [blueId, redId] })).status).toBe(200);

    detail = await (await shop(`/v1/shop/catalog/products/${slug}`)).json() as { variants: { options: { name: string; group: { name: string } }[] }[] };
    expect(detail.variants[0]!.options.map((o) => ({ group: o.group.name, name: o.name }))).toEqual([
      { group: 'Apple Size', name: 'Large' },
      { group: 'Apple Size', name: 'Small' },
      { group: 'Zebra Color', name: 'Blue' },
      { group: 'Zebra Color', name: 'Red' },
    ]);
  });
});
