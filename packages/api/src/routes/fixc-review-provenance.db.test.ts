/** Fix-C regressions: review purchase proof provenance, erasure scrubbing of edit snapshots, birthday batch drain. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { createSession } from '../auth/session.js';
import { account } from './account.js';
import { submitReview, approveReview } from '../reviews/reviews.js';
import { grantBirthdayBonuses } from '../loyalty/bonus.js';

assertTestDatabase(env.DATABASE_URL, 'fixc regressions');
const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee5555';
const SLUG = 'fixc-test';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-0000000000b1';
const PRODUCT = 'eeeeeeee-eeee-eeee-eeee-0000000000b2';
const VARIANT = 'eeeeeeee-eeee-eeee-eeee-0000000000b3';
const ORDER = 'eeeeeeee-eeee-eeee-eeee-0000000000b4';
const app = new OpenAPIHono();
app.route('/', account);

const PROGRAM = { enabled: true, earnRatePerDollar: 1, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null,
  reviewBonusPoints: 50, reviewBonusVerifiedOnly: true, signupBonusPoints: 0, signupBonusSince: null, firstOrderBonusPoints: 0, birthdayBonusPoints: 10, productMultipliers: [] };
let storeRow: { name: string; currency: string; config: unknown };

async function seed(verified: boolean, linkedVia: 'email_match' | 'session') {
  await pool.query('TRUNCATE store CASCADE');
  let token = '';
  const config = { loyalty: PROGRAM, reviews: { requirePurchase: true } };
  storeRow = { name: 'x', currency: 'USD', config };
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, 'x', 'USD', ${JSON.stringify(config)}::jsonb)`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'p', 'P', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type) VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, 'S1', 'V', 1000, 'digital_download')`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified, first_name) VALUES (${CUSTOMER}, ${STORE}, 'new@example.test', ${verified}, 'N')`);
    token = await createSession(tx, STORE, CUSTOMER);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id, state, grand_total, shipping_address, billing_address, metadata)
      VALUES (${ORDER}, ${STORE}, 'O-1', ${CUSTOMER}, 'Paid', 1000, '{"name":"Old Owner","line1":"9 Secret Rd"}', '{"name":"Old Owner"}',
      ${JSON.stringify({ linked_via: linkedVia, contact: { email: linkedVia === 'session' ? 'new@example.test' : 'old@example.test' } })}::jsonb)`);
    await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total) VALUES (${STORE}, ${ORDER}, ${VARIANT}, 'S1', 'V', 1, 1000, 1000, 1000)`);
  });
  return token;
}
const body = { rating: 5, body: 'Great product indeed, very good.' } as never;
const cust = { id: CUSTOMER, email: 'new@example.test', emailVerified: true, firstName: 'N', lastName: null };
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });

describe('review purchase proof provenance', () => {
  beforeEach(async () => { await seed(true, 'email_match'); });
  it('unproven old-mailbox link cannot submit a verified-buyer review', async () => {
    const r = await withStore(STORE, (tx) => submitReview(tx, { storeId: STORE, store: storeRow, productSlug: 'p', review: body, customer: cust }));
    expect(r).toEqual({ ok: false, reason: 'purchase_required' });
  });
  it('unproven link never earns the purchase-restricted bonus, even if a stale verified review exists', async () => {
    const id = crypto.randomUUID();
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO product_review (id, store_id, product_id, customer_id, order_id, author_name, author_email, rating, body, status, verified_buyer)
        VALUES (${id}, ${STORE}, ${PRODUCT}, ${CUSTOMER}, ${ORDER}, 'N', 'new@example.test', 5, 'Great product indeed.', 'pending', true)`);
    });
    const out = await withStore(STORE, (tx) => approveReview(tx, { storeId: STORE, reviewId: id, actor: 't', store: storeRow }));
    expect(out?.bonusPoints).toBe(0);
    const n = await withStore(STORE, (tx) => tx.execute<{ c: string }>(sql`SELECT count(*)::text c FROM loyalty_ledger WHERE kind = 'bonus'`));
    expect(n.rows[0]!.c).toBe('0');
  });
  it('session-linked order still qualifies', async () => {
    await seed(true, 'session');
    const r = await withStore(STORE, (tx) => submitReview(tx, { storeId: STORE, store: storeRow, productSlug: 'p', review: body, customer: cust }));
    expect(r).toMatchObject({ ok: true, verifiedBuyer: true });
  });
});

describe('erasure scrubs order-edit and address-audit snapshots', () => {
  it('removes address PII, keeps amounts', async () => {
    const token = await seed(true, 'session');
    await withStore(STORE, async (tx) => {
      const snapA = { totals: { grandTotal: 1000 }, shippingAddress: { name: 'Old Owner', line1: '9 Secret Rd', email: 'old@example.test' }, billingAddress: { name: 'Old Owner' }, lines: [{ sku: 'S1', lineTotal: 1000 }] };
      await tx.execute(sql`INSERT INTO order_edit (store_id, order_id, before, after, balance, reason) VALUES (${STORE}, ${ORDER}, ${JSON.stringify(snapA)}::jsonb, ${JSON.stringify({ ...snapA, totals: { grandTotal: 1200 } })}::jsonb, 200, 'for Old Owner')`);
      await tx.execute(sql`INSERT INTO order_edit (store_id, order_id, before, after, balance) VALUES (${STORE}, ${ORDER}, '{"addresses":{"shipping":{"line1":"9 Secret Rd"}}}'::jsonb, '{"addresses":{"shipping":{"line1":"1 New Rd"}}}'::jsonb, 0)`);
      await tx.execute(sql`INSERT INTO audit_log (store_id, entity, entity_id, action, data) VALUES (${STORE}, 'order', ${ORDER}, 'edit_address', '{"kind":"shipping","before":{"line1":"9 Secret Rd"},"after":{"line1":"1 New Rd"},"reason":"x"}'::jsonb)`);
    });
    const res = await app.request('/v1/shop/account', { method: 'DELETE', headers: { 'x-store-slug': SLUG, authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const rows = await withStore(STORE, async (tx) => ({
      edits: (await tx.execute<{ before: unknown; after: unknown; balance: number }>(sql`SELECT before, after, balance FROM order_edit WHERE order_id = ${ORDER} ORDER BY balance DESC`)).rows,
      audit: (await tx.execute<{ data: unknown }>(sql`SELECT data FROM audit_log WHERE action = 'edit_address'`)).rows,
    }));
    const dump = JSON.stringify(rows);
    for (const pii of ['Old Owner', 'old@example.test', '9 Secret Rd', '1 New Rd', 'for Old']) expect(dump).not.toContain(pii);
    expect(rows.edits[0]!.balance).toBe(200);
    expect((rows.edits[0]!.after as { totals: { grandTotal: number } }).totals.grandTotal).toBe(1200);
    expect((rows.audit[0]!.data as { kind: string }).kind).toBe('shipping');
  });
});

describe('birthday batching', () => {
  it('drains >batch (and above the old 2000 selection limit) eligible customers across runs and never grants twice', async () => {
    await seed(true, 'session');
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO customer (store_id, email, email_verified, birth_month, birth_day)
      SELECT ${STORE}, 'b' || g || '@example.test', true, 3, 5 FROM generate_series(1, 2100) g`));
    const now = new Date('2027-03-05T10:00:00Z');
    expect(await withStore(STORE, (tx) => grantBirthdayBonuses(tx, STORE, now))).toBe(2100);
    expect(await withStore(STORE, (tx) => grantBirthdayBonuses(tx, STORE, now))).toBe(0);
    const n = await withStore(STORE, (tx) => tx.execute<{ c: string }>(sql`SELECT count(*)::text c FROM loyalty_ledger WHERE source_ref LIKE 'bonus:birthday:%'`));
    expect(n.rows[0]!.c).toBe('2100');
  });
});
