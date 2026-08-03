/**
 * DB test for SEC-OWNER-2: /v1/admin/staff/accept is documented PUBLIC (see
 * admin-settings-advanced.ts — "no admin auth; isolation is the token") but
 * was still behind the admin CSRF gate, which only exempted /login and
 * /logout. A brand-new invitee has no admin session yet, so no sr_csrf cookie
 * exists to double-submit — the flow was 403'd and unreachable from a browser.
 * Mirrors app.cors.db.test.ts: real Hono app via createApp(), real DB.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { pool } from './db/client.js';
import { env } from './env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
// This suite needs a real Postgres — the shared *_test database, never a dev
// or prod one (it TRUNCATEs). Not wired into package.json's `test`/`test:db`
// split (out of scope for this change), so it self-gates: skip cleanly when
// DATABASE_URL isn't pointed at a _test database instead of throwing and
// failing the whole run. Run explicitly with DATABASE_URL=…/sellright_test.
const isTestDb = /_test(\b|$|\?)/.test(DB);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

beforeEach(async () => { if (isTestDb) await wipe(); });
afterAll(async () => { if (isTestDb) await wipe(); await pool.end(); });

describe.skipIf(!isTestDb)('POST /v1/admin/staff/accept — CSRF exemption (SEC-OWNER-2)', () => {
  it('is reachable with no x-csrf-token header and no sr_csrf cookie (a new invitee has neither)', async () => {
    const app = createApp();
    const res = await app.request('/v1/admin/staff/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'bogus-invite-token', password: 'password123' }),
    });
    // Never 403 CSRF — the handler's own token validation runs and correctly
    // rejects the bogus/unknown token as 409, proving the request reached the
    // route body instead of being blocked at the CSRF middleware.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid|expired/i);
  });

  it('still 403s an unrelated cookie-session admin mutation with no CSRF token (regression: gate still enforced elsewhere)', async () => {
    const app = createApp();
    const res = await app.request('/v1/admin/staff', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // A cookie-session request (no bearer Authorization) with no
        // x-csrf-token — must still be blocked, proving the accept-endpoint
        // exemption above is narrowly scoped and doesn't weaken the gate.
        cookie: 'sr_admin=some-session-token-value',
      },
      body: JSON.stringify({ email: 'x@example.com', role: 'staff', password: 'password123' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/csrf/i);
  });
});
