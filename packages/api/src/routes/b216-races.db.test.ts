/**
 * Security plan rev 8, B2.16 (reported, unconfirmed concerns — confirmed in code at 8c752cf, fixed here):
 *  1. magic-link vs e-mail change: a sign-in link could be minted for the ABANDONED address after the change committed.
 *  2. contact-mail cooldown race: concurrent submissions for one address each sent a confirmation.
 *  3. newsletter cooldown bypass: a new free-text `topic` per request = a new row + a new confirmation e-mail.
 *  4. guest receipts: a receipt-token read showed the linked account's CURRENT e-mail (changed after the order).
 * (Live Activity registration after logout is covered with the device/session binding in the admin-push tests.)
 * sellright_test only (TRUNCATEs).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';

vi.mock('../security/turnstile.js', async (orig) => ({ ...(await orig<typeof import('../security/turnstile.js')>()), verifyTurnstileToken: vi.fn(async () => true) }));

import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';
import { auth } from './auth.js';
import { contactRoutes } from './contact.js';
import { shopExtra } from './shop-extra.js';
import { orders } from './orders.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from '../auth/rate-limit-backend.js';

const isTestDb = /^\/[^/]*_test$/.test(new URL(process.env.DATABASE_URL ?? env.DATABASE_URL).pathname);
const STORE = 'b2160000-0000-4000-8000-000000000001';
const SLUG = 'b216-races';
const CUST = 'b2160000-0000-4000-8000-0000000000c1';
const app = new OpenAPIHono();
app.route('/', auth); app.route('/', contactRoutes); app.route('/', shopExtra); app.route('/', orders);

let ip = 0;
const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-real-ip': `198.51.100.${(++ip % 250) + 1}` }, body: JSON.stringify(body),
});
const outboxCount = async (kind: string) => Number(((await withStore(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE store_id = ${STORE} AND kind = ${kind}`))).rows[0] as { n: number }).n);

/** Wait until some backend is blocked BY the fixture's own backend (not by any unrelated lock). */
async function waitForBlockedQuery(blockerPid: number) {
  let waiting = 0;
  for (let i = 0; i < 400 && !waiting; i++) {
    waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [blockerPid])).rowCount ?? 0;
    if (!waiting) await new Promise((r) => setTimeout(r, 25));
  }
  return waiting;
}

beforeEach(async () => {
  if (!isTestDb) return;
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  await pool.query('TRUNCATE store CASCADE');
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'B216', 'USD', $3)`,
    [STORE, SLUG, JSON.stringify({ auth: { magicLink: true }, notifications: { contactEmail: 'team@b216.test' } })]);
  await pool.query(`INSERT INTO customer (id, store_id, email, email_verified) VALUES ($1, $2, 'old@b216.test', true)`, [CUST, STORE]);
  invalidateStoreCache(SLUG);
});
afterAll(async () => { if (isTestDb) await pool.query('TRUNCATE store CASCADE'); _setRateLimitBackendForTest(undefined); await pool.end(); });

describe.skipIf(!isTestDb)('B2.16 races', () => {
  it('1. a magic link is never minted for the address an in-flight e-mail change abandons', async () => {
    const other = await pool.connect();
    let pending: Promise<Response> | Response | undefined;
    try {
      const pid = Number((await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      // The e-mail change (verify-email-change) holds the customer row and moves it to the new address.
      await other.query('BEGIN');
      await other.query(`SELECT set_config('app.current_store', $1, true)`, [STORE]);
      await other.query(`SELECT id FROM customer WHERE id = $1 FOR UPDATE`, [CUST]);
      await other.query(`UPDATE customer SET email = 'new@b216.test' WHERE id = $1`, [CUST]);
      pending = post('/v1/shop/auth/magic-link/request', { email: 'old@b216.test' });
      expect(await waitForBlockedQuery(pid)).toBeGreaterThan(0);
      await other.query('COMMIT');
      expect((await pending).status).toBe(200); // enumeration-neutral as always
    } finally {
      // never leave the fixture transaction (and its row lock) open on failure, nor the request unsettled
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
      await Promise.resolve(pending).catch(() => undefined);
    }
    const minted = await withStore(STORE, (tx) => tx.execute(sql`SELECT 1 FROM customer_token WHERE customer_id = ${CUST} AND kind = 'magic_link'`));
    expect(minted.rows).toHaveLength(0);
    expect(await outboxCount('magic_link')).toBe(0);
  });

  it('2. concurrent contact submissions for one address send ONE confirmation', async () => {
    const body = { name: 'V', email: 'victim@b216.test', subject: 'hi', message: 'hello there, a real message' };
    await Promise.all(Array.from({ length: 5 }, () => post('/v1/shop/contact', body)));
    expect(await outboxCount('contact_confirm')).toBe(1);
  });

  it('3. switching the newsletter topic does not bypass the per-address cooldown', async () => {
    for (let i = 0; i < 6; i++) expect((await post('/v1/shop/newsletter-signup', { email: 'victim@b216.test', topic: `t${i}` })).status).toBe(200);
    const sent = await withStore(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE store_id = ${STORE} AND recipient = 'victim@b216.test'`));
    expect(Number((sent.rows[0] as { n: number }).n)).toBe(3); // the per-address cap, not zero
    // concurrent variant
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => post('/v1/shop/newsletter-signup', { email: 'other@b216.test', topic: `c${i}` })));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const sent2 = await withStore(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE store_id = ${STORE} AND recipient = 'other@b216.test'`));
    expect(Number((sent2.rows[0] as { n: number }).n)).toBe(3);
  });

  it('4. a receipt-token read shows the checkout address, never the account\'s later e-mail', async () => {
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO "order" (store_id, code, customer_id, state, receipt_token, grand_total, metadata)
      VALUES (${STORE}, 'B216-R', ${CUST}, 'Paid', 'receipt-b216', 1000, '{"linked_via":"email_match","contact":{"email":"old@b216.test"}}')`));
    await pool.query(`UPDATE customer SET email = 'private-new@b216.test' WHERE id = $1`, [CUST]);
    const res = await app.request('/v1/shop/orders/B216-R?rt=receipt-b216', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('private-new@b216.test');
    const body = JSON.parse(text) as { customerEmail: string | null; contactEmail: string | null };
    expect(body.contactEmail).toBe('old@b216.test');
  });
});
