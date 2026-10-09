/**
 * Owner-parity P1 gaps, route level against a *_test database (TRUNCATEs):
 *   G8  affiliate stats by date range with per-SKU sales
 *   G10 waitlist demand report (+ CSV)
 *   G11 sitemap preview + refresh (+ IndexNow)
 *   G12 clear a customer's SheerID verification (permission + audit)
 * Auth, withStore and RLS run exactly as in production via app.request().
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminAffiliate } from './admin-affiliate.js';
import { adminWaitlist } from './admin-waitlist.js';
import { adminSeo } from './admin-seo.js';
import { sheeridRoutes } from './sheerid.js';
import { adminReports } from './admin-reports.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-p1-gaps.db.test.ts');

const STORE = 'f1f1f1f1-0000-4000-8000-0000000000f0';
const OTHER_STORE = 'f1f1f1f1-0000-4000-8000-0000000000f9';
const SLUG = 'p1-gaps-store';
const OWNER = 'f1f1f1f1-0000-4000-8000-0000000000a1';
const STAFF = 'f1f1f1f1-0000-4000-8000-0000000000a2';
const STAFF_GRANTED = 'f1f1f1f1-0000-4000-8000-0000000000a3';
const READONLY = 'f1f1f1f1-0000-4000-8000-0000000000a4';
const P1 = 'f1f1f1f1-0000-4000-8000-0000000000b1';
const P2 = 'f1f1f1f1-0000-4000-8000-0000000000b2';
const V1 = 'f1f1f1f1-0000-4000-8000-0000000000c1';
const V2 = 'f1f1f1f1-0000-4000-8000-0000000000c2';
const V3 = 'f1f1f1f1-0000-4000-8000-0000000000c3';
const PROMO = 'f1f1f1f1-0000-4000-8000-0000000000d1';
const PROMO_OTHER = 'f1f1f1f1-0000-4000-8000-0000000000d2';
const AFF = 'f1f1f1f1-0000-4000-8000-0000000000e1';
const CUST = 'f1f1f1f1-0000-4000-8000-0000000000f1';
const CUST_OTHER_STORE = 'f1f1f1f1-0000-4000-8000-0000000000f2';

const app = new OpenAPIHono();
for (const r of [adminAffiliate, adminWaitlist, adminSeo, sheeridRoutes, adminReports]) app.route('/', r);

const tokens: Record<string, string> = {};

/** RLS is forced for the app role, so raw reads need a store context. */
const rows = (storeId: string, text: string, params: unknown[] = []) =>
  withStore(storeId, async (tx) => (await tx.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, i) => `'${String(params[Number(i) - 1]).replace(/'/g, "''")}'`)))).rows as Array<Record<string, any>>);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

const req = (who: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function seed() {
  const cfg = JSON.stringify({ seo: { siteUrl: 'https://shop.example.com', indexNow: { key: 'abcdef0123456789' } } });
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'P1 Gaps', 'USD', $3::jsonb)`, [STORE, SLUG, cfg]);
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'p1-gaps-other', 'Other', 'USD')`, [OTHER_STORE]);
  for (const [id, email, role, perms] of [
    [OWNER, 'owner@p1.test', 'owner', '{}'], [STAFF, 'staff@p1.test', 'staff', '{}'],
    [STAFF_GRANTED, 'granted@p1.test', 'staff', '{"customer_verification":true}'], [READONLY, 'ro@p1.test', 'read_only', '{"customer_verification":true}'],
  ] as const) {
    await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
    await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role, permissions) VALUES ($1, $2, $3, $4::jsonb)`, [id, STORE, role, perms]);
    tokens[id] = await createAdminSession(id);
  }

  await withStore(STORE, async (tx) => {
    // catalog
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${P1}, ${STORE}, 'alpha', 'Alpha Knife', 'active'), (${P2}, ${STORE}, 'beta', '=Beta, "Quoted"', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES
      (${V1}, ${STORE}, ${P1}, 'A-1', 'Alpha / Black', 1000), (${V2}, ${STORE}, ${P1}, 'A-2', 'Alpha / Green', 1000), (${V3}, ${STORE}, ${P2}, 'B-1', 'Beta', 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${V1}, ${STORE}, 0, 0), (${V2}, ${STORE}, 5, 2), (${V3}, ${STORE}, 0, 0)`);

    // G8: promo + affiliate + orders
    await tx.execute(sql`INSERT INTO promotion (id, store_id, code, type, value, enabled) VALUES (${PROMO}, ${STORE}, 'AFF10', 'percentage', 10, true), (${PROMO_OTHER}, ${STORE}, 'OTHER', 'percentage', 10, true)`);
    await tx.execute(sql`INSERT INTO affiliate (id, store_id, promotion_id, email, access_token, onboarded_at) VALUES (${AFF}, ${STORE}, ${PROMO}, 'aff@p1.test', 'tok-p1-gaps-aaaaaaaaaaaaaaaa', now())`);
    const order = async (id: string, code: string, state: string, promo: string, subtotal: number, discount: number, placed: string) =>
      tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, subtotal, discount_total, promotion_id, placed_at) VALUES (${id}::uuid, ${STORE}, ${code}, ${state}::order_state, ${subtotal}, ${discount}, ${promo}::uuid, ${placed}::timestamptz)`);
    const line = async (oid: string, variant: string, sku: string, name: string, qty: number, subtotal: number, disc: number) =>
      tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_discount, line_total)
        VALUES (${STORE}, ${oid}::uuid, ${variant}::uuid, ${sku}, ${name}, ${qty}, ${Math.round(subtotal / qty)}, ${subtotal}, ${disc}, ${subtotal - disc})`);
    const O1 = 'f1f1f1f1-0000-4000-8000-000000000101'; const O2 = 'f1f1f1f1-0000-4000-8000-000000000102';
    const O3 = 'f1f1f1f1-0000-4000-8000-000000000103'; const O4 = 'f1f1f1f1-0000-4000-8000-000000000104'; const O5 = 'f1f1f1f1-0000-4000-8000-000000000105';
    await order(O1, 'AFFO1', 'Paid', PROMO, 10000, 1000, '2026-09-10T12:00:00Z');
    await line(O1, V1, 'A-1', 'Alpha / Black', 2, 6000, 600);
    await line(O1, V2, 'A-2', 'Alpha / Green', 1, 4000, 400);
    await order(O2, 'AFFO2', 'PartiallyRefunded', PROMO, 5000, 0, '2026-10-05T23:30:00Z');
    await line(O2, V1, 'A-1', 'Alpha / Black', 1, 5000, 0);
    await order(O3, 'AFFO3', 'Refunded', PROMO, 9000, 0, '2026-10-06T10:00:00Z'); // earns nothing
    await line(O3, V1, 'A-1', 'Alpha / Black', 3, 9000, 0);
    await order(O4, 'AFFO4', 'PendingPayment', PROMO, 7000, 0, '2026-10-07T10:00:00Z'); // not paid
    await line(O4, V3, 'B-1', 'Beta', 1, 7000, 0);
    await order(O5, 'AFFO5', 'Paid', PROMO_OTHER, 8000, 0, '2026-10-05T10:00:00Z'); // someone else's promo
    await line(O5, V3, 'B-1', 'Beta', 1, 8000, 0);

    // G10: waitlist
    const rr = async (variant: string, email: string, status: string, pname: string, vname: string, slug: string, created: string) =>
      tx.execute(sql`INSERT INTO restock_request (store_id, variant_id, email, product_name, variant_name, product_slug, status, created_at, notified_at)
        VALUES (${STORE}, ${variant}::uuid, ${email}, ${pname}, ${vname}, ${slug}, ${status}, ${created}::timestamptz, ${status === 'notified' ? created : null}::timestamptz)`);
    await rr(V1, 'a@w.test', 'pending', 'Alpha Knife', 'Alpha / Black', 'alpha', '2026-09-01T00:00:00Z');
    await rr(V1, 'b@w.test', 'pending', 'Alpha Knife', 'Alpha / Black', 'alpha', '2026-10-01T00:00:00Z');
    await rr(V1, 'c@w.test', 'notified', 'Alpha Knife', 'Alpha / Black', 'alpha', '2026-08-01T00:00:00Z');
    await rr(V1, 'd@w.test', 'canceled', 'Alpha Knife', 'Alpha / Black', 'alpha', '2026-08-02T00:00:00Z');
    await rr(V2, 'a@w.test', 'pending', 'Alpha Knife', 'Alpha / Green', 'alpha', '2026-09-15T00:00:00Z');
    await rr(V3, 'e@w.test', 'pending', '=Beta, "Quoted"', 'Beta', 'beta', '2026-09-20T00:00:00Z');
    const sub = async (email: string, topic: string, status: string, created: string) =>
      tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status, created_at) VALUES (${STORE}, ${email}, 'waitlist', ${topic}, ${status}, ${created}::timestamptz)`);
    await sub('f@w.test', `restock:${V1}`, 'confirmed', '2026-09-05T00:00:00Z'); // legacy lane, waiting
    await sub('g@w.test', `restock:${V2}`, 'pending', '2026-09-06T00:00:00Z'); // never confirmed
    await sub('h@w.test', `restock:${V1}`, 'unsubscribed', '2026-09-07T00:00:00Z'); // consumed/unsubscribed
    await sub('i@w.test', 'restock:not-a-uuid', 'confirmed', '2026-09-07T00:00:00Z'); // malformed topic ignored
    await sub('j@w.test', 'newsletter-ish', 'confirmed', '2026-09-07T00:00:00Z'); // other topic ignored
    // another store's demand must never leak into this report
  });
  await withStore(OTHER_STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status) VALUES (${OTHER_STORE}, 'x@other.test', 'waitlist', ${`restock:${V1}`}, 'confirmed')`);
  });

  // G12 customers
  const soon = new Date(Date.now() + 90 * 86_400_000).toISOString();
  const entries = JSON.stringify([
    { programId: 'prog', category: 'student', verificationId: 'ver-1', status: 'verified', discountPercent: 15, verifiedAt: '2026-09-01T00:00:00Z', expiresAt: soon },
    { programId: 'imp', category: 'military', verificationId: null, status: 'verified', discountPercent: 10, verifiedAt: '2025-01-01T00:00:00Z', expiresAt: null },
  ]);
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, sheerid_verifications, active_verifications) VALUES (${CUST}, ${STORE}, 'v@p1.test', ${entries}::jsonb, ${'{student,military}'}::text[])`);
    await tx.execute(sql`INSERT INTO sheerid_verification (store_id, customer_id, verification_id, program_id, category, status, discount_percent, expires_at)
      VALUES (${STORE}, ${CUST}, 'ver-1', 'prog', 'student', 'success', 15, ${soon}::timestamptz)`);
  });
  await withStore(OTHER_STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, active_verifications) VALUES (${CUST_OTHER_STORE}, ${OTHER_STORE}, 'v@other.test', ${'{student}'}::text[])`);
  });
}

beforeEach(async () => { await wipe(); await seed(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('G8 affiliate stats by date range', () => {
  type Stats = { range: { from: string | null; to: string | null }; commissionPct: number; totals: { orders: number; units: number; revenue: number; commission: number }; bySku: Array<{ sku: string; units: number; orders: number; revenue: number; commission: number }> };
  const stats = async (qs = '') => (await req(OWNER, 'GET', `/v1/admin/affiliates/${AFF}/stats${qs}`));

  it('lifetime totals reconcile with the affiliate detail earned figure; unpaid, refunded and foreign-promo orders are excluded', async () => {
    const res = await stats();
    expect(res.status).toBe(200);
    const b = await res.json() as Stats;
    expect(b.totals).toEqual({ orders: 2, units: 4, revenue: 14000, commission: 1400 });
    expect(b.bySku.map((r) => [r.sku, r.units, r.orders, r.revenue, r.commission])).toEqual([['A-1', 3, 2, 10400, 1040], ['A-2', 1, 1, 3600, 360]]);
    const detail = await (await req(OWNER, 'GET', `/v1/admin/affiliates/${AFF}`)).json() as { earned: number };
    expect(b.totals.commission).toBe(detail.earned);
  });

  it('bounds are inclusive UTC days', async () => {
    const oct = await (await stats('?from=2026-10-01&to=2026-10-05')).json() as Stats;
    expect(oct.totals).toEqual({ orders: 1, units: 1, revenue: 5000, commission: 500 }); // placed 23:30Z on the 5th is in
    const sep = await (await stats('?from=2026-09-10&to=2026-09-10')).json() as Stats;
    expect(sep.totals.orders).toBe(1);
    expect(sep.bySku.map((r) => r.sku)).toEqual(['A-1', 'A-2']);
    const none = await (await stats('?from=2026-10-06')).json() as Stats;
    expect(none.totals).toEqual({ orders: 0, units: 0, revenue: 0, commission: 0 });
    expect(none.bySku).toEqual([]);
    expect(none.range).toEqual({ from: '2026-10-06', to: null });
  });

  it('rejects malformed or inverted ranges and unknown affiliates', async () => {
    expect((await stats('?from=2026-13-01')).status).toBe(400);
    expect((await stats('?from=2026-10-09&to=2026-10-01')).status).toBe(400);
    const missing = await req(OWNER, 'GET', '/v1/admin/affiliates/f1f1f1f1-0000-4000-8000-0000000000ff/stats');
    expect(missing.status).toBe(404);
  });

  it('is readable by read-only staff (view permission only)', async () => {
    expect((await req(READONLY, 'GET', `/v1/admin/affiliates/${AFF}/stats`)).status).toBe(200);
  });
});

describe('G10 waitlist demand report', () => {
  type Row = { key: string; productName: string; variantName: string | null; sku: string | null; available: number | null; variants: number; pending: number; notified: number; canceled: number; unconfirmed: number; legacyClosed: number; total: number; lastSignupAt: string | null; oldestPendingAt: string | null };
  type Report = { groupBy: string; summary: Record<string, number>; rows: Row[]; truncated: boolean; range: { from: string | null; to: string | null } };
  const report = async (qs = '', who = OWNER) => { const r = await req(who, 'GET', `/v1/admin/waitlist/report${qs}`); expect(r.status).toBe(200); return r.json() as Promise<Report>; };

  it('counts both signup lanes per variant, sorted by pending demand, scoped to this store', async () => {
    const r = await report();
    expect(r.rows.map((x) => x.sku)).toEqual(['A-1', 'A-2', 'B-1']);
    const a1 = r.rows[0]!;
    // restock_request: 2 pending / 1 notified / 1 canceled; legacy lane: +1 confirmed (waiting), +1 consumed. The other store's row is invisible.
    expect(a1).toMatchObject({ pending: 3, notified: 1, canceled: 1, unconfirmed: 0, legacyClosed: 1, total: 6, available: 0, variants: 1, variantName: 'Alpha / Black' });
    expect(a1.oldestPendingAt).toBe('2026-09-01T00:00:00.000Z');
    expect(a1.lastSignupAt).toBe('2026-10-01T00:00:00.000Z');
    expect(r.rows[1]).toMatchObject({ pending: 1, unconfirmed: 1, total: 2, available: 3 });
    expect(r.summary).toMatchObject({ pending: 5, notified: 1, canceled: 1, unconfirmed: 1, legacyClosed: 1, total: 9, variants: 3, products: 2 });
  });

  it('groups by product and sorts by any whitelisted column', async () => {
    const p = await report('?groupBy=product');
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({ productName: 'Alpha Knife', variants: 2, pending: 4, total: 8, variantName: null, available: 3 });
    const byName = await report('?sort=product&dir=asc');
    expect(byName.rows.map((x) => x.productName)).toEqual(['=Beta, "Quoted"', 'Alpha Knife', 'Alpha Knife']); // '=' sorts before letters
    const byTotal = await report('?sort=total&dir=asc');
    expect(byTotal.rows.map((x) => x.total)).toEqual([1, 2, 6]);
    expect((await req(OWNER, 'GET', '/v1/admin/waitlist/report?sort=email')).status).toBe(400);
  });

  it('filters signups by created-at range (inclusive UTC days)', async () => {
    const r = await report('?from=2026-09-01&to=2026-09-15');
    const a1 = r.rows.find((x) => x.sku === 'A-1')!;
    expect(a1).toMatchObject({ pending: 2, notified: 0, canceled: 0, legacyClosed: 1, total: 3 }); // a@ (09-01), f@ (09-05), h@ (09-07)
    expect(r.rows.find((x) => x.sku === 'B-1')).toBeUndefined(); // 09-20 is out
    expect((await req(OWNER, 'GET', '/v1/admin/waitlist/report?from=bad')).status).toBe(400);
  });

  it('downloads CSV with spreadsheet-formula and quote escaping, no emails', async () => {
    const res = await req(OWNER, 'GET', '/v1/admin/waitlist/report.csv?sort=product&dir=asc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('waitlist-demand-variant.csv');
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('Product,Variant,SKU,Waiting now,Notified,Canceled,Unconfirmed,Legacy closed,Total signups,In stock now,Oldest waiting,Latest signup');
    expect(lines[1]!.startsWith(`"'=Beta, ""Quoted""",Beta,B-1,1,0,0,0,0,1,0,`)).toBe(true);
    expect(text).not.toMatch(/@w\.test/);
    const prod = await (await req(OWNER, 'GET', '/v1/admin/waitlist/report.csv?groupBy=product')).text();
    expect(prod.split('\n')[0]).toBe('Product,Variants,Waiting now,Notified,Canceled,Unconfirmed,Legacy closed,Total signups,In stock now,Oldest waiting,Latest signup');
  });
});

describe('G11 sitemap preview + refresh', () => {
  it('lists every sitemap file with counts and the exact URLs served', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO blog_post (store_id, slug, title, is_published) VALUES (${STORE}, 'hello', 'Hello', true), (${STORE}, 'draft', 'Draft', false)`);
    });
    const res = await req(OWNER, 'GET', '/v1/admin/seo/sitemaps');
    expect(res.status).toBe(200);
    const b = await res.json() as { configured: boolean; indexUrl: string; totalUrls: number; indexNowConfigured: boolean; files: Array<{ name: string; url: string; count: number; urls: Array<{ loc: string }> }> };
    expect(b.configured).toBe(true);
    expect(b.indexUrl).toBe('https://shop.example.com/sitemap.xml');
    expect(b.indexNowConfigured).toBe(true);
    // no published collections -> the collections file is not advertised (same rule as the public index)
    expect(b.files.map((f) => f.name)).toEqual(['sitemap-main.xml', 'sitemap-products.xml', 'sitemap-blog.xml']);
    const products = b.files.find((f) => f.name === 'sitemap-products.xml')!;
    expect(products.count).toBe(2);
    expect(products.urls.map((u) => u.loc)).toEqual(['https://shop.example.com/products/alpha/', 'https://shop.example.com/products/beta/']);
    expect(b.files.find((f) => f.name === 'sitemap-blog.xml')!.urls.map((u) => u.loc)).toEqual(['https://shop.example.com/blog/hello/']);
    expect(b.totalUrls).toBe(1 + 2 + 1);
  });

  it('reports an unconfigured store instead of failing', async () => {
    await pool.query(`UPDATE store SET config = '{}'::jsonb WHERE id = $1`, [STORE]);
    const b = await (await req(OWNER, 'GET', '/v1/admin/seo/sitemaps')).json() as { configured: boolean; files: unknown[] };
    expect(b).toMatchObject({ configured: false, files: [] });
    expect((await req(OWNER, 'POST', '/v1/admin/seo/sitemaps/refresh', {})).status).toBe(409);
  });

  it('refresh without a CDN or IndexNow still succeeds and writes an audit row', async () => {
    const res = await req(STAFF, 'POST', '/v1/admin/seo/sitemaps/refresh', {});
    expect(res.status).toBe(200);
    const b = await res.json() as { totalUrls: number; cdn: { configured: boolean; purged: boolean; urls: string[] }; indexNow: { attempted: boolean } };
    expect(b.cdn.configured).toBe(false);
    expect(b.cdn.purged).toBe(false);
    expect(b.cdn.urls).toContain('https://shop.example.com/sitemap-collections.xml'); // purged even though currently unlisted
    expect(b.indexNow.attempted).toBe(false);
    const audit = { rows: await rows(STORE, `SELECT actor FROM audit_log WHERE store_id = $1 AND action = 'sitemaps_refreshed'`, [STORE]) };
    expect(audit.rows).toEqual([{ actor: 'staff@p1.test' }]);
    expect((await req(READONLY, 'POST', '/v1/admin/seo/sitemaps/refresh', {})).status).toBe(403);
  });

  it('refresh with indexNow submits every sitemap URL once; a rejected submission is reported, not thrown', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const ok = await (await req(OWNER, 'POST', '/v1/admin/seo/sitemaps/refresh', { indexNow: true })).json() as { indexNow: { attempted: boolean; submitted: number; ok: boolean } };
    expect(ok.indexNow).toMatchObject({ attempted: true, ok: true, submitted: 3 }); // '/', alpha, beta
    const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as { urlList: string[]; key: string };
    expect(sent.urlList).toEqual(['https://shop.example.com/', 'https://shop.example.com/products/alpha/', 'https://shop.example.com/products/beta/']);
    expect(sent.key).toBe('abcdef0123456789');

    fetchMock.mockResolvedValue(new Response('', { status: 429 }));
    const bad = await (await req(OWNER, 'POST', '/v1/admin/seo/sitemaps/refresh', { indexNow: true })).json() as { indexNow: { ok: boolean; status: number; submitted: number } };
    expect(bad.indexNow).toMatchObject({ ok: false, status: 429, submitted: 0 });
  });

  it('refuses IndexNow when no key is configured', async () => {
    await pool.query(`UPDATE store SET config = '{"seo":{"siteUrl":"https://shop.example.com"}}'::jsonb WHERE id = $1`, [STORE]);
    expect((await req(OWNER, 'POST', '/v1/admin/seo/sitemaps/refresh', { indexNow: true })).status).toBe(409);
  });
});

describe('G12 clear SheerID verification', () => {
  type State = { active: string[]; entries: Array<{ category: string; source: string }>; attempts: Array<{ status: string }>; history: Array<{ action: string; actor: string | null; categories: string[]; reason: string | null }>; canClear: boolean };
  const state = async (who = OWNER) => (await (await req(who, 'GET', `/v1/admin/customers/${CUST}/verification`)).json()) as State;
  const clear = (who: string, body: unknown, id = CUST) => req(who, 'POST', `/v1/admin/customers/${id}/verification/clear`, body);

  it('shows active categories, provenance and who may clear', async () => {
    const s = await state();
    expect(s.active.sort()).toEqual(['military', 'student']);
    expect(s.entries.map((e) => [e.category, e.source]).sort()).toEqual([['military', 'imported'], ['student', 'sheerid']]);
    expect(s.canClear).toBe(true);
    expect((await state(STAFF)).canClear).toBe(false);
    expect((await state(STAFF_GRANTED)).canClear).toBe(true);
    expect((await state(READONLY)).canClear).toBe(false); // read-only role never clears, even with the key
  });

  it('is permission gated: plain staff and read-only get 403, a granted staff member succeeds', async () => {
    const denied = await clear(STAFF, { reason: 'fraud check' });
    expect(denied.status).toBe(403);
    expect(String(((await denied.json()) as { error: { message: string } }).error.message)).toMatch(/customer_verification/);
    expect((await clear(READONLY, { reason: 'fraud check' })).status).toBe(403);
    expect((await clear(STAFF_GRANTED, { reason: 'fraud check' })).status).toBe(200);
  });

  it('requires a reason', async () => {
    expect((await clear(OWNER, {})).status).toBe(400);
    expect((await clear(OWNER, { reason: 'x' })).status).toBe(400);
  });

  it('clears every category: rows revoked, imported entry stripped, eligibility gone, one audit entry with the reason', async () => {
    const res = await clear(OWNER, { reason: 'Wrong person verified' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: ['military', 'student'], rowsRevoked: 1, importedRemoved: 1, active: [] });
    const s = await state();
    expect(s.active).toEqual([]);
    expect(s.entries).toEqual([]);
    expect(s.attempts.map((a) => a.status)).toEqual(['revoked']);
    expect(s.history).toEqual([expect.objectContaining({ action: 'verification_cleared', actor: 'owner@p1.test', categories: ['military', 'student'], reason: 'Wrong person verified' })]);
    const row = { rows: await rows(STORE, `SELECT active_verifications, sheerid_verifications FROM customer WHERE id = $1`, [CUST]) };
    expect(row.rows[0]).toEqual({ active_verifications: [], sheerid_verifications: [] });
  });

  it('can clear a single category and leaves the other intact', async () => {
    const res = await clear(OWNER, { category: 'military', reason: 'imported entry was wrong' });
    expect(await res.json()).toMatchObject({ cleared: ['military'], rowsRevoked: 0, importedRemoved: 1, active: ['student'] });
    expect((await state()).active).toEqual(['student']);
  });

  it('is idempotent: nothing left to clear writes no second audit row', async () => {
    await clear(OWNER, { reason: 'first' });
    const again = await clear(OWNER, { reason: 'second' });
    expect(await again.json()).toEqual({ cleared: [], rowsRevoked: 0, importedRemoved: 0, active: [] });
    const audit = { rows: await rows(STORE, `SELECT count(*)::int AS n FROM audit_log WHERE store_id = $1 AND action = 'verification_cleared'`, [STORE]) };
    expect(audit.rows[0]!.n).toBe(1);
  });

  it("cannot touch another store's customer and 404s for unknown ids", async () => {
    expect((await clear(OWNER, { reason: 'cross tenant' }, CUST_OTHER_STORE)).status).toBe(404);
    const other = { rows: await rows(OTHER_STORE, `SELECT active_verifications FROM customer WHERE id = $1`, [CUST_OTHER_STORE]) };
    expect(other.rows[0]!.active_verifications).toEqual(['student']);
    expect((await req(OWNER, 'GET', `/v1/admin/customers/${CUST_OTHER_STORE}/verification`)).status).toBe(404);
  });

  it('the legacy revoke endpoint now honours the same permission', async () => {
    const denied = await req(STAFF, 'POST', '/v1/admin/sheerid/revoke', { customerId: CUST, category: 'student' });
    expect(denied.status).toBe(403);
    const ok = await req(OWNER, 'POST', '/v1/admin/sheerid/revoke', { customerId: CUST, category: 'student' });
    expect(ok.status).toBe(200);
  });
});
