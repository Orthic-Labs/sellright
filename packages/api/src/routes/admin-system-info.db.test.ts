/**
 * Read-only system endpoints (plan 2.7): owner-only build-info + effective-config (config/v1).
 * Secrets must appear only as fingerprints; `intended` must be stable and content-addressed.
 */
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';

// Set BEFORE the first env/sign-key read (imports no longer touch env at load).
const COOKIE_SECRET = 'cookie-secret-for-system-info-test';
const MASTER = 'master-key-material-for-system-info-test-0123456789';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.env.COOKIE_SECRET = COOKIE_SECRET;
process.env.SELLRIGHT_MASTER_KEY = MASTER;
process.env.LICENSE_SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n');
process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_systeminfo_secret_value';

const { pool } = await import('../db/client.js');
const { createAdminSession } = await import('../auth/admin-session.js');
const { hashPassword } = await import('../auth/password.js');
const { assertTestDatabase } = await import('../db/rls-test-utils.js');
const { adminSystemInfo } = await import('./admin-system-info.js');
const { hmacFingerprint, publicKeyFingerprint } = await import('../sdk/fingerprint.js');
const { contentFingerprint } = await import('../sdk/effective-config.js');

assertTestDatabase(process.env.DATABASE_URL ?? '', 'admin-system-info.db.test.ts');

const STORE = 'eeeeeeee-0000-0000-0000-00000000b101';
const SLUG = 'system-info-test-store';
const OWNER = 'eeeeeeee-0000-0000-0000-00000000b102';
const MANAGER = 'eeeeeeee-0000-0000-0000-00000000b103';
const OTHER_STORE = 'eeeeeeee-0000-0000-0000-00000000b104';
const OTHER_OWNER = 'eeeeeeee-0000-0000-0000-00000000b105';
const PLAIN_OWNER = 'eeeeeeee-0000-0000-0000-00000000b106';
const MANIFEST = { schema: 2, appKey: 'demo', documents: [{ id: 'a', role: 'license' }] };
const CONFIG = {
  hostnames: ['shop.example.test', 'www.example.test'],
  legalManifests: { demo: MANIFEST },
  auth: { magicLink: true, sessionTtlDays: 7 },
  stripe: { mode: 'live' },
  paymentAccounts: { nmi: 'acct-nmi-1' },
};

const app = new OpenAPIHono();
app.route('/', adminSystemInfo);

let ownerToken = '';
let managerToken = '';
let otherOwnerToken = '';
let plainOwnerToken = '';

beforeAll(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  const hash = await hashPassword('pw-system-info-test');
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'SI', 'USD', $3::jsonb)`, [STORE, SLUG, JSON.stringify(CONFIG)]);
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'system-info-other-store', 'Other', 'USD', '{}'::jsonb)`, [OTHER_STORE]);
  // [id, email, role, store, installation admin]
  for (const [id, email, role, store, inst] of [
    [OWNER, 'owner@si.test', 'owner', STORE, true],
    [MANAGER, 'mgr@si.test', 'manager', STORE, false],           // manager of the store, not owner, not installation admin (one installation admin per install)
    [PLAIN_OWNER, 'plain@si.test', 'owner', STORE, false],       // owner of THIS store, not an installation admin
    [OTHER_OWNER, 'other@si.test', 'owner', OTHER_STORE, false], // owner of another store of the same install
  ] as const) {
    await pool.query(`INSERT INTO admin_user (id, email, password_hash, is_installation_admin) VALUES ($1, $2, $3, $4)`, [id, email, hash, inst]);
    await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3)`, [id, store, role]);
  }
  ownerToken = await createAdminSession(OWNER);
  managerToken = await createAdminSession(MANAGER);
  plainOwnerToken = await createAdminSession(PLAIN_OWNER);
  otherOwnerToken = await createAdminSession(OTHER_OWNER);
});

afterAll(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  await pool.end();
});

const get = (path: string, token?: string) =>
  app.request(path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-store-slug': SLUG } });

describe.each(['/v1/admin/system/build-info', '/v1/admin/system/effective-config'])('%s access', (path) => {
  it('401 without a session; 200 only for an installation admin who owns the store', async () => {
    expect((await get(path)).status).toBe(401);
    expect((await get(path, managerToken)).status).toBe(403); // manager, not the store owner
    expect((await get(path, plainOwnerToken)).status).toBe(403); // store owner, not an installation admin
    expect((await get(path, ownerToken)).status).toBe(200);
  });

  it('403 for a non-installation owner of ANOTHER store, even naming that store (review F1)', async () => {
    const own = await app.request(path, { headers: { authorization: `Bearer ${otherOwnerToken}`, 'x-store-slug': 'system-info-other-store' } });
    expect(own.status).toBe(403);
    const cross = await app.request(path, { headers: { authorization: `Bearer ${otherOwnerToken}`, 'x-store-slug': SLUG } });
    expect(cross.status).toBe(403);
    expect(await cross.text()).not.toContain('fingerprint');
  });
});

describe('build-info', () => {
  it('reports engine, node, migration journal identity and (when present) BUILD-INFO.json', async () => {
    const body = await (await get('/v1/admin/system/build-info', ownerToken)).json() as Record<string, any>;
    expect(body.engine).toEqual({ name: '@sellright/api', version: '0.1.0' });
    expect(body.node).toBe(process.version);
    expect(body.migrationJournalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.migrationHead).toMatch(/^\d{4}_/);
    expect(body.plugins).toEqual([]);
    if (body.build !== null) expect(body.build).toEqual(expect.objectContaining({ sha: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: expect.any(Boolean) }));
  });
});

describe('effective-config config/v1', () => {
  it('has the two sections and projects store config content', async () => {
    const body = await (await get('/v1/admin/system/effective-config', ownerToken)).json() as Record<string, any>;
    expect(body.schema).toBe('config/v1');
    expect(Object.keys(body).sort()).toEqual(['deployment', 'intended', 'schema', 'store']);
    expect(body.intended.storeConfig.hostnames).toEqual(CONFIG.hostnames);
    expect(body.intended.storeConfig.legalManifests).toEqual({ demo: contentFingerprint(MANIFEST) });
    expect(body.intended.storeConfig.auth).toEqual(expect.objectContaining({ magicLink: true, sessionTtlDays: 7 }));
    expect(body.deployment.providers.stripe.mode).toBe('live');
    expect(body.deployment.providers.nmi.accountId).toBe('acct-nmi-1');
    expect(body.deployment.database).toEqual(expect.objectContaining({ host: expect.any(String), database: expect.stringMatching(/_test$/) }));
    expect(body.deployment.jobs).toEqual(expect.objectContaining({ enabled: false }));
  });

  it('secrets appear only as fingerprints (public-key digest, salted HMAC); no raw value anywhere', async () => {
    const res = await get('/v1/admin/system/effective-config', ownerToken);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;
    const s = body.intended.secrets;
    const { rows: [saltRow] } = await pool.query(`SELECT value FROM installation_setting WHERE key = 'config_fingerprint_salt'`);
    const SALT = saltRow.value as string;
    expect(SALT).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, stored server-side
    expect(s.LICENSE_SIGNING_KEY).toEqual({ set: true, fingerprint: publicKeyFingerprint(publicKey) });
    expect(s.COOKIE_SECRET).toEqual({ set: true, fingerprint: hmacFingerprint(COOKIE_SECRET, 'COOKIE_SECRET', SALT) });
    expect(s.SELLRIGHT_MASTER_KEY).toEqual({ set: true, fingerprint: hmacFingerprint(MASTER, 'SELLRIGHT_MASTER_KEY', SALT) });
    expect(s.STRIPE_SECRET_KEY_LIVE.fingerprint).toBe(hmacFingerprint('sk_live_systeminfo_secret_value', 'STRIPE_SECRET_KEY_LIVE', SALT));
    expect(s.TURNSTILE_SECRET_KEY).toEqual({ set: false, fingerprint: null });
    expect(text).not.toContain(SALT);
    // the old unsalted construction (key = secret, public label) must NOT reproduce the value
    expect(s.COOKIE_SECRET.fingerprint).not.toBe(createHmac('sha256', COOKIE_SECRET).update('sellright/config/v1:COOKIE_SECRET').digest('hex').slice(0, 16));
    for (const raw of [COOKIE_SECRET, MASTER, 'sk_live_systeminfo_secret_value', 'BEGIN PRIVATE KEY', privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')]) {
      expect(text).not.toContain(raw);
    }
    // the database credential never leaves: host/db only
    expect(JSON.stringify(body.deployment.database)).not.toMatch(/password|@/);
  });

  it('the salt is created once and reused: fingerprints are stable across calls', async () => {
    const a = (await (await get('/v1/admin/system/effective-config', ownerToken)).json() as Record<string, any>).intended.secrets.COOKIE_SECRET.fingerprint;
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM installation_setting WHERE key = 'config_fingerprint_salt'`);
    expect(rows[0].n).toBe(1);
    expect((await (await get('/v1/admin/system/effective-config', ownerToken)).json() as Record<string, any>).intended.secrets.COOKIE_SECRET.fingerprint).toBe(a);
  });

  it('`intended` is stable across calls and changes when store config content changes', async () => {
    const a = (await (await get('/v1/admin/system/effective-config', ownerToken)).json() as Record<string, any>).intended;
    const b = (await (await get('/v1/admin/system/effective-config', ownerToken)).json() as Record<string, any>).intended;
    expect(a).toEqual(b);
    await pool.query(`UPDATE store SET config = jsonb_set(config, '{legalManifests,demo,schema}', '3') WHERE id = $1`, [STORE]);
    const c = (await (await get('/v1/admin/system/effective-config', ownerToken)).json() as Record<string, any>).intended;
    expect(c.storeConfig.legalManifests.demo).not.toBe(a.storeConfig.legalManifests.demo);
    expect(c.storeConfig.hostnames).toEqual(a.storeConfig.hostnames);
  });
});
