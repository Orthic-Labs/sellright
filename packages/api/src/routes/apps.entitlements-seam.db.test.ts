/**
 * DB test for the generic entitlements seam (licensing/entitlement-provider.ts)
 * wired into the four public license lifecycle routes in apps.ts: activate,
 * refresh, deactivate, trial.
 *
 * Covers exactly the seam's contract:
 *   - no provider registered  => every route's response is byte-for-byte the
 *     same shape it was before this seam existed
 *   - provider adds fields    => those fields land in the JSON response
 *   - provider vetoes         => the route returns the veto's status/body AND
 *     the underlying DB work (activation row, trial license/customer) never
 *     committed
 *   - provider throws a plain Error => the client gets the app's generic,
 *     sanitized error (never the raw hook message), and — same as a veto —
 *     nothing the hook or the route did that transaction partially commits
 *
 * Runs against a *_test database (TRUNCATEs). Self-gates like its siblings
 * (apps.store-resolution.db.test.ts, activations-engine.db.test.ts): skips
 * cleanly unless DATABASE_URL points at a `_test` database.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';
import {
  clearEntitlementProvider,
  EntitlementVeto,
  registerEntitlementProvider,
  type EntitlementProvider,
} from '../licensing/entitlement-provider.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`apps.entitlements-seam test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

// The store's slug doubles as the license's appKey — publicAppStore()
// resolves the store by treating body.app as the store slug directly.
const STORE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const APP_KEY = 'entseam-app';
const LICENSE_KEY = 'ENTSEAM-LIC-1';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed() {
  await withStore(STORE_ID, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE_ID}, ${APP_KEY}, ${APP_KEY}, 'USD', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO license (id, store_id, app_key, license_key, status, seats, metadata, source)
      VALUES (gen_random_uuid(), ${STORE_ID}, ${APP_KEY}, ${LICENSE_KEY}, 'active'::license_status, 3, '{}'::jsonb, 'admin')
      ON CONFLICT DO NOTHING
    `);
  });
}

function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

// Verification queries MUST go through withStore(): these tables sit under
// FORCE ROW LEVEL SECURITY, scoped by the transaction-local app.current_store
// setting. A raw pool.query() with no store context set matches zero rows
// regardless of what's actually in the table — silently, not an error — so
// every assertion helper below runs inside the same store-scoped transaction
// the routes themselves use.
async function activationCount(deviceId: string): Promise<number> {
  return withStore(STORE_ID, async (tx) => {
    const r = await tx.execute(sql`
      SELECT count(*)::int AS n FROM license_activation
      WHERE store_id = ${STORE_ID} AND device_id_hash = ${hashDeviceId(deviceId)}
    `);
    return (r.rows[0] as { n: number }).n;
  });
}

async function licenseMetadata(): Promise<unknown> {
  return withStore(STORE_ID, async (tx) => {
    const r = await tx.execute(sql`SELECT metadata FROM license WHERE store_id = ${STORE_ID} AND license_key = ${LICENSE_KEY}`);
    return (r.rows[0] as { metadata: unknown } | undefined)?.metadata ?? null;
  });
}

async function customerCount(email: string): Promise<number> {
  return withStore(STORE_ID, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS n FROM customer WHERE store_id = ${STORE_ID} AND email = ${email}`);
    return (r.rows[0] as { n: number }).n;
  });
}

async function trialLicenseCount(email: string): Promise<number> {
  return withStore(STORE_ID, async (tx) => {
    const r = await tx.execute(sql`
      SELECT count(*)::int AS n FROM license lic
        JOIN customer cust ON cust.id = lic.customer_id
      WHERE lic.store_id = ${STORE_ID} AND lic.app_key = ${APP_KEY} AND cust.email = ${email}
    `);
    return (r.rows[0] as { n: number }).n;
  });
}

async function activate(app: ReturnType<typeof createApp>, deviceId: string) {
  return app.request('/api/licenses/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: APP_KEY, deviceId, licenseKey: LICENSE_KEY }),
  });
}

beforeEach(async () => {
  invalidateStoreCache();
  await wipe();
  await seed();
});

afterEach(async () => {
  clearEntitlementProvider();
  await wipe();
});

afterAll(() => pool.end());

describe('entitlements seam — no provider registered', () => {
  it('activate/refresh/deactivate/trial are all unchanged from their pre-seam shape', async () => {
    const app = createApp();

    const actRes = await activate(app, 'dev-baseline');
    expect(actRes.status).toBe(200);
    const actBody = (await actRes.json()) as Record<string, unknown>;
    expect(Object.keys(actBody).sort()).toEqual(
      ['activationToken', 'licenseId', 'message', 'ok', 'status', 'updatesUntil'].sort(),
    );
    const activationToken = actBody.activationToken as string;

    const refRes = await app.request('/api/licenses/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, activationToken, deviceId: 'dev-baseline' }),
    });
    expect(refRes.status).toBe(200);
    const refBody = (await refRes.json()) as Record<string, unknown>;
    expect(Object.keys(refBody).sort()).toEqual(
      ['expiresAt', 'licenseId', 'ok', 'status', 'updatesUntil'].sort(),
    );

    const deactRes = await app.request('/api/licenses/deactivate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, activationToken }),
    });
    expect(deactRes.status).toBe(200);
    expect(await deactRes.json()).toEqual({ ok: true });
    expect(await activationCount('dev-baseline')).toBe(0);

    const trialRes = await app.request('/v1/licenses/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, email: 'baseline@example.com' }),
    });
    expect(trialRes.status).toBe(200);
    const trialBody = (await trialRes.json()) as Record<string, unknown>;
    expect(Object.keys(trialBody).sort()).toEqual(['message', 'ok', 'status'].sort());
  });
});

describe('entitlements seam — provider adds fields', () => {
  const provider: EntitlementProvider = {
    onActivate: async () => ({ signedToken: 'tok-activate', entitlements: { v: 1, tier: 'pro' } }),
    onRefresh: async () => ({ signedToken: 'tok-refresh' }),
    onDeactivate: async () => ({ revoked: true }),
    onTrial: async () => ({ trialTier: 'pro' }),
  };

  it('activate response includes the hook fields alongside the built-ins', async () => {
    registerEntitlementProvider(provider);
    const app = createApp();
    const res = await activate(app, 'dev-fields');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, signedToken: 'tok-activate', entitlements: { v: 1, tier: 'pro' } });
  });

  it('refresh response includes the hook fields', async () => {
    registerEntitlementProvider(provider);
    const app = createApp();
    const actBody = (await (await activate(app, 'dev-fields-2')).json()) as { activationToken: string };
    const res = await app.request('/api/licenses/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, activationToken: actBody.activationToken, deviceId: 'dev-fields-2' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, signedToken: 'tok-refresh' });
  });

  it('deactivate response includes the hook fields and still frees the seat', async () => {
    registerEntitlementProvider(provider);
    const app = createApp();
    const actBody = (await (await activate(app, 'dev-fields-3')).json()) as { activationToken: string };
    const res = await app.request('/api/licenses/deactivate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, activationToken: actBody.activationToken }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(await activationCount('dev-fields-3')).toBe(0);
  });

  it('trial response includes the hook fields', async () => {
    registerEntitlementProvider(provider);
    const app = createApp();
    const res = await app.request('/v1/licenses/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, email: 'fields@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, trialTier: 'pro' });
  });
});

describe('entitlements seam — provider vetoes', () => {
  it('activate: veto returns its status/body and the activation never commits', async () => {
    registerEntitlementProvider({
      onActivate: async () => { throw new EntitlementVeto(503, 'signing_unavailable', 'signer is down'); },
    });
    const app = createApp();
    const res = await activate(app, 'dev-veto-act');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, status: 'signing_unavailable', message: 'signer is down' });
    expect(await activationCount('dev-veto-act')).toBe(0);
  });

  it('activate: a hook that mutates the license row then vetoes rolls that mutation back too', async () => {
    registerEntitlementProvider({
      onActivate: async (tx, ctx) => {
        await tx.execute(sql`UPDATE license SET metadata = '{"marked":true}'::jsonb WHERE id = ${ctx.license.id}`);
        throw new EntitlementVeto(409, 'blocked', 'nope');
      },
    });
    const app = createApp();
    const res = await activate(app, 'dev-veto-mutate');
    expect(res.status).toBe(409);
    expect(await licenseMetadata()).toEqual({}); // hook's UPDATE never committed
    expect(await activationCount('dev-veto-mutate')).toBe(0);
  });

  it('refresh: veto returns its status/body without altering activation state', async () => {
    const app = createApp();
    const actBody = (await (await activate(app, 'dev-veto-ref')).json()) as { activationToken: string };
    registerEntitlementProvider({
      onRefresh: async () => { throw new EntitlementVeto(400, 'device_id_required', 'need a device id'); },
    });
    const res = await app.request('/api/licenses/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, activationToken: actBody.activationToken, deviceId: 'dev-veto-ref' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, status: 'device_id_required', message: 'need a device id' });
    expect(await activationCount('dev-veto-ref')).toBe(1); // still active — refresh didn't touch it
  });

  it('deactivate: veto prevents the seat from being freed', async () => {
    const app = createApp();
    const actBody = (await (await activate(app, 'dev-veto-deact')).json()) as { activationToken: string };
    registerEntitlementProvider({
      onDeactivate: async () => { throw new EntitlementVeto(403, 'support_hold', 'account is on a support hold'); },
    });
    const res = await app.request('/api/licenses/deactivate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, activationToken: actBody.activationToken }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, status: 'support_hold', message: 'account is on a support hold' });
    expect(await activationCount('dev-veto-deact')).toBe(1); // seat NOT freed
  });

  it('trial: veto prevents both the customer and the license from being created', async () => {
    registerEntitlementProvider({
      onTrial: async () => { throw new EntitlementVeto(429, 'rate_limited', 'too many trial requests'); },
    });
    const app = createApp();
    const res = await app.request('/v1/licenses/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, email: 'veto-trial@example.com' }),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, status: 'rate_limited', message: 'too many trial requests' });
    expect(await customerCount('veto-trial@example.com')).toBe(0);
    expect(await trialLicenseCount('veto-trial@example.com')).toBe(0);
  });
});

describe('entitlements seam — provider throws an unexpected error', () => {
  it('activate: the client gets a generic, sanitized error — never the raw hook message — and nothing commits', async () => {
    registerEntitlementProvider({
      onActivate: async () => { throw new Error('leaked internal stack trace / secret detail'); },
    });
    const app = createApp();
    const res = await activate(app, 'dev-err-act');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/leaked internal stack trace|secret detail/);
    expect(await activationCount('dev-err-act')).toBe(0);
  });

  it('trial: an unexpected hook error sanitizes the response and mints nothing', async () => {
    registerEntitlementProvider({
      onTrial: async () => { throw new Error('db password is hunter2'); },
    });
    const app = createApp();
    const res = await app.request('/v1/licenses/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, email: 'err-trial@example.com' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/hunter2/);
    expect(await customerCount('err-trial@example.com')).toBe(0);
    expect(await trialLicenseCount('err-trial@example.com')).toBe(0);
  });

  it('deactivate: an unexpected hook error leaves the seat allocated (rolled back, not partially freed)', async () => {
    const app = createApp();
    const actBody = (await (await activate(app, 'dev-err-deact')).json()) as { activationToken: string };
    registerEntitlementProvider({
      onDeactivate: async () => { throw new Error('boom'); },
    });
    const res = await app.request('/api/licenses/deactivate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: APP_KEY, activationToken: actBody.activationToken }),
    });
    expect(res.status).toBe(500);
    expect(await activationCount('dev-err-deact')).toBe(1);
  });
});
