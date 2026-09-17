/**
 * DB tests for renewable customer sessions (ported upstream from RightSites;
 * here the policy is per-store config auth.* over env defaults — SellRight's
 * default remains 30-day non-renewable).
 *
 * Covers:
 *   1. A renewable session inside the renew window is EXTENDED and the new
 *      expiry is persisted server-side (not just reported).
 *   2. Outside the window, resolve leaves the expiry untouched.
 *   3. /auth/me-style force-renew extends even outside the window — but only
 *      when the store's policy is renewable.
 *   4. A renewed session is still revoked by logout (token hash unchanged).
 *   5. An expired session resolves null and is never renewed.
 *   6. The default (unconfigured) policy does not renew — existing sessions
 *      and clients are unaffected.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { createSession, deleteSession, resolveCustomer } from './session.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`session.renewal test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const DAY = 86_400_000;
const STORE_RENEW = 'dddddddd-1111-1111-1111-111111111111';
const STORE_PLAIN = 'dddddddd-2222-2222-2222-222222222222';
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

beforeEach(async () => {
  await wipe();
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, 'renew-store', 'Renew', 'USD', $3::jsonb),
       ($2, 'plain-store', 'Plain', 'USD', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [STORE_RENEW, STORE_PLAIN, JSON.stringify({ auth: { renewable: true, sessionTtlDays: 365, sessionRenewWindowDays: 30 } })],
  );
});
afterAll(async () => { await wipe(); await pool.end(); });

async function seedCustomer(storeId: string, email: string): Promise<string> {
  return withStore(storeId, async (tx) => {
    const [c] = await tx.insert(s.customer).values({ storeId, email, emailVerified: true }).returning({ id: s.customer.id });
    return c!.id;
  });
}

/** Insert a session with an explicit expiry, return the raw bearer token. */
async function sessionWithExpiry(storeId: string, customerId: string, expiresAt: Date): Promise<string> {
  return withStore(storeId, async (tx) => {
    const token = 'tok_' + createHash('sha256').update(`${customerId}:${expiresAt.toISOString()}`).digest('hex');
    await tx.insert(s.session).values({ storeId, customerId, tokenHash: hashToken(token), expiresAt });
    return token;
  });
}

async function sessionExpiry(storeId: string, token: string): Promise<Date | null> {
  return withStore(storeId, async (tx) => {
    const [row] = await tx.select({ expiresAt: s.session.expiresAt }).from(s.session).where(eq(s.session.tokenHash, hashToken(token))).limit(1);
    return row?.expiresAt ?? null;
  });
}

describe('renewable session policy', () => {
  it('extends a session inside the renew window and persists the new expiry', async () => {
    const custId = await seedCustomer(STORE_RENEW, 'renew@a.test');
    const soon = new Date(Date.now() + 10 * DAY); // inside the 30d window of a 365d policy
    const token = await sessionWithExpiry(STORE_RENEW, custId, soon);

    const cust = await withStore(STORE_RENEW, (tx) => resolveCustomer(tx, token));
    expect(cust?.id).toBe(custId);

    const after = await sessionExpiry(STORE_RENEW, token);
    expect(after).not.toBeNull();
    // ~now+365d — assert a generous lower bound, not an exact timestamp.
    expect(after!.getTime()).toBeGreaterThan(Date.now() + 300 * DAY);
    expect(after!.getTime()).toBeLessThanOrEqual(Date.now() + 366 * DAY);
  });

  it('leaves the expiry alone outside the renew window', async () => {
    const custId = await seedCustomer(STORE_RENEW, 'fresh@a.test');
    const far = new Date(Date.now() + 200 * DAY); // outside the 30d window
    const token = await sessionWithExpiry(STORE_RENEW, custId, far);
    await withStore(STORE_RENEW, (tx) => resolveCustomer(tx, token));
    expect((await sessionExpiry(STORE_RENEW, token))!.getTime()).toBe(far.getTime());
  });

  it('force-renew (/auth/me) extends even outside the window when renewable', async () => {
    const custId = await seedCustomer(STORE_RENEW, 'force@a.test');
    const far = new Date(Date.now() + 200 * DAY);
    const token = await sessionWithExpiry(STORE_RENEW, custId, far);
    await withStore(STORE_RENEW, (tx) => resolveCustomer(tx, token, true));
    const after = await sessionExpiry(STORE_RENEW, token);
    expect(after!.getTime()).toBeGreaterThan(far.getTime());
    expect(after!.getTime()).toBeLessThanOrEqual(Date.now() + 366 * DAY);
  });

  it('a renewed session is still revoked by logout', async () => {
    const custId = await seedCustomer(STORE_RENEW, 'revoke@a.test');
    const token = await sessionWithExpiry(STORE_RENEW, custId, new Date(Date.now() + 10 * DAY));
    await withStore(STORE_RENEW, (tx) => resolveCustomer(tx, token)); // renews
    await withStore(STORE_RENEW, (tx) => deleteSession(tx, token));
    expect(await withStore(STORE_RENEW, (tx) => resolveCustomer(tx, token))).toBeNull();
    expect(await sessionExpiry(STORE_RENEW, token)).toBeNull();
  });

  it('an expired session resolves null and is never renewed', async () => {
    const custId = await seedCustomer(STORE_RENEW, 'gone@a.test');
    const token = await sessionWithExpiry(STORE_RENEW, custId, new Date(Date.now() - 1000));
    expect(await withStore(STORE_RENEW, (tx) => resolveCustomer(tx, token))).toBeNull();
    expect(await withStore(STORE_RENEW, (tx) => resolveCustomer(tx, token, true))).toBeNull();
  });

  it('the default policy does not renew (existing behavior preserved)', async () => {
    const custId = await seedCustomer(STORE_PLAIN, 'plain@b.test');
    const soon = new Date(Date.now() + DAY); // inside ANY window — must not move
    const token = await sessionWithExpiry(STORE_PLAIN, custId, soon);
    const cust = await withStore(STORE_PLAIN, (tx) => resolveCustomer(tx, token));
    expect(cust?.id).toBe(custId);
    expect((await sessionExpiry(STORE_PLAIN, token))!.getTime()).toBe(soon.getTime());
    // force-renew is a no-op too: renewal is opt-in
    await withStore(STORE_PLAIN, (tx) => resolveCustomer(tx, token, true));
    expect((await sessionExpiry(STORE_PLAIN, token))!.getTime()).toBe(soon.getTime());
  });

  it('createSession honors the store ttl (365d here, 30d by default)', async () => {
    const a = await seedCustomer(STORE_RENEW, 'ttl@a.test');
    const b = await seedCustomer(STORE_PLAIN, 'ttl@b.test');
    const tokA = await withStore(STORE_RENEW, (tx) => createSession(tx, STORE_RENEW, a));
    const tokB = await withStore(STORE_PLAIN, (tx) => createSession(tx, STORE_PLAIN, b));
    const expA = (await sessionExpiry(STORE_RENEW, tokA))!.getTime();
    const expB = (await sessionExpiry(STORE_PLAIN, tokB))!.getTime();
    expect(expA).toBeGreaterThan(Date.now() + 300 * DAY);
    expect(expB).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(expB).toBeLessThan(Date.now() + 31 * DAY);
  });
});
