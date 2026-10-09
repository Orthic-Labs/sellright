/**
 * DB tests for the StoreKit port (upstream: RightSites storekit-webhooks.ts +
 * the link-storekit endpoint of pro-devices.ts, genericized).
 *
 * Runs against the lane test DB only (sr_storekit_test). Exercises:
 *   - POST /v1/shop/pro/link-storekit — signed StoreKit JWS → license minted
 *     + device activated; idempotent on replay; wrong product/environment → 4xx
 *   - POST /v1/webhooks/apple/storekit — App Store Server Notifications v2:
 *     REFUND revokes license+purchase, REFUND_REVERSED restores, DID_RENEW
 *     extends expiresAt, duplicate notificationUUID is a replay-safe no-op,
 *     TEST/unrelated types ack-and-ignore.
 *
 * Signatures are real JWS (ES256, x5c chain) minted by a throwaway openssl CA —
 * the verifier override injects SignedDataVerifier instances rooted at that CA
 * (enableOnlineChecks off), exactly like licensing/storekit-verify.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign as cryptoSign, X509Certificate, createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createSession } from '../auth/session.js';
import { storeKitWebhooks } from './storekit-webhooks.js';
import { _setStoreKitVerifierOverrideForTests } from '../licensing/storekit-config.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `storekit-webhooks test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@]+@/, ':***@')}`,
  );
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01';
const SLUG = 'storekit-test-store';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee02';
const CUSTOMER_B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee03';
const APP_KEY = 'exampleapp';
const BUNDLE_ID = 'app.example.ios';
const PRODUCT_ID = 'app.example.pro.lifetime';
const APP_APPLE_ID = 123456789;
const ORIG_TXN = '3000000123456789';
const DEVICE_HASH = createHash('sha256').update('ios-device-1').digest('hex');

const LEAF_EKU_OID = '1.2.840.113635.100.6.11.1';
const INTERMEDIATE_EKU_OID = '1.2.840.113635.100.6.2.1';

const app = new OpenAPIHono();
app.route('/', storeKitWebhooks);

// ── throwaway Apple-like CA fixture (mirrors storekit-verify.test.ts) ───────
let dir: string;
let leafPrivPem: string;
let x5c: string[];
let sandboxVerifier: SignedDataVerifier;
let prodVerifier: SignedDataVerifier;

function run(cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' });
}
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}
function derB64Of(file: string): string {
  return readFileSync(join(dir, file), 'utf8')
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
}
function makeJws(payload: Record<string, unknown>): string {
  const headerB64 = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', x5c })));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = cryptoSign('sha256', Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), {
    key: createPrivateKey(leafPrivPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${headerB64}.${payloadB64}.${b64url(sig)}`;
}
function txnPayload(overrides?: Record<string, unknown>) {
  return {
    transactionId: `${Date.now()}`,
    originalTransactionId: ORIG_TXN,
    bundleId: BUNDLE_ID,
    productId: PRODUCT_ID,
    environment: 'Sandbox',
    purchaseDate: Date.now(),
    originalPurchaseDate: Date.now(),
    signedDate: Date.now(),
    type: 'Non-Consumable',
    ...overrides,
  };
}
function notifPayload(type: string, uuid: string, txn?: Record<string, unknown>, envName = 'Sandbox') {
  return {
    notificationType: type,
    notificationUUID: uuid,
    data: {
      environment: envName,
      bundleId: BUNDLE_ID,
      bundleVersion: '1',
      // Apple's SignedDataVerifier requires data.appAppleId to equal the
      // verifier's configured appAppleId for Production attempts (checked
      // before the environment check, so a missing value poisons the whole
      // attempt rather than falling through to Sandbox).
      appAppleId: APP_APPLE_ID,
      ...(txn ? { signedTransactionInfo: makeJws(txn) } : {}),
    },
    version: '2.0',
    signedDate: Date.now(),
  };
}

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

// Seeds run inside withStore so FORCE-RLS applies exactly as it does for the
// request path under test — a nonowner connection cannot bypass tenant
// isolation to plant fixtures.
async function seed(allowSandbox = true) {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, 'StoreKit Test Store', 'USD', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email)
      VALUES (${CUSTOMER}, ${STORE}, 'sk-customer@example.com')
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email)
      VALUES (${CUSTOMER_B}, ${STORE}, 'sk-customer-b@example.com')
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO storekit_app
        (store_id, app_key, bundle_id, app_apple_id, allow_sandbox, product_map)
      VALUES (${STORE}, ${APP_KEY}, ${BUNDLE_ID}, ${APP_APPLE_ID}, ${allowSandbox},
        ${JSON.stringify({ [PRODUCT_ID]: { tier: 'pro', seats: 0 } })}::jsonb)
      ON CONFLICT (bundle_id) DO UPDATE
        SET allow_sandbox = ${allowSandbox},
            product_map = ${JSON.stringify({ [PRODUCT_ID]: { tier: 'pro', seats: 0 } })}::jsonb`);
  });
}

async function post(path: string, body: unknown, headers?: Record<string, string>) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, ...headers },
    body: JSON.stringify(body),
  });
}

async function licenseForPurchase() {
  return withStore(STORE, async (tx) => {
    const rows = await tx.select().from(s.storekitPurchase).where(eq(s.storekitPurchase.originalTransactionId, ORIG_TXN));
    const lic = rows[0]?.licenseId
      ? (await tx.select().from(s.license).where(eq(s.license.id, rows[0].licenseId)))[0]
      : null;
    return { purchase: rows[0] ?? null, license: lic ?? null };
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sk-route-test-'));
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key']);
  run('openssl', ['req', '-x509', '-new', '-key', 'root.key', '-days', '3650', '-subj', '/CN=Test Root CA/', '-addext', 'basicConstraints=critical,CA:true', '-out', 'root.pem']);
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'inter.key']);
  run('openssl', ['req', '-new', '-key', 'inter.key', '-subj', '/CN=Test Intermediate CA/', '-out', 'inter.csr']);
  writeFileSync(join(dir, 'inter.ext'), `basicConstraints=critical,CA:true\n${INTERMEDIATE_EKU_OID}=critical,ASN1:NULL\n`);
  run('openssl', ['x509', '-req', '-in', 'inter.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '3650', '-extfile', 'inter.ext', '-out', 'inter.pem']);
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key']);
  run('openssl', ['req', '-new', '-key', 'leaf.key', '-subj', '/CN=Test StoreKit Leaf/', '-out', 'leaf.csr']);
  writeFileSync(join(dir, 'leaf.ext'), `basicConstraints=critical,CA:false\n${LEAF_EKU_OID}=critical,ASN1:NULL\n`);
  run('openssl', ['x509', '-req', '-in', 'leaf.csr', '-CA', 'inter.pem', '-CAkey', 'inter.key', '-CAcreateserial', '-days', '3650', '-extfile', 'leaf.ext', '-out', 'leaf.pem']);
  leafPrivPem = readFileSync(join(dir, 'leaf.key'), 'utf8');
  x5c = [derB64Of('leaf.pem'), derB64Of('inter.pem'), derB64Of('root.pem')];

  const rootDer = new X509Certificate(readFileSync(join(dir, 'root.pem'), 'utf8')).raw;
  sandboxVerifier = new SignedDataVerifier([rootDer], false, Environment.SANDBOX, BUNDLE_ID);
  prodVerifier = new SignedDataVerifier([rootDer], false, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID);
  _setStoreKitVerifierOverrideForTests(() => ({ production: prodVerifier, sandbox: sandboxVerifier }));
});

afterAll(async () => {
  _setStoreKitVerifierOverrideForTests(undefined);
  rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

beforeEach(async () => {
  await wipe();
  await seed();
});

describe('POST /v1/shop/pro/link-storekit', () => {
  it('verifies a signed purchase, mints a license + activation, and binds the account', async () => {
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const res = await post('/v1/shop/pro/link-storekit', {
      appKey: APP_KEY,
      signedTransactionInfo: makeJws(txnPayload()),
      deviceIdHash: DEVICE_HASH,
      platform: 'ios',
    }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; activationToken: string; lease: { deviceIdHash: string; entitlement: string | null } };
    expect(body.ok).toBe(true);
    expect(body.activationToken.length).toBeGreaterThan(10);
    expect(body.lease.deviceIdHash).toBe(DEVICE_HASH);
    expect(body.lease.entitlement).toBe('pro');

    const { purchase, license } = await licenseForPurchase();
    expect(purchase).not.toBeNull();
    expect(purchase!.environment).toBe('Sandbox');
    expect(purchase!.productId).toBe(PRODUCT_ID);
    expect(purchase!.customerId).toBe(CUSTOMER);
    expect(purchase!.status).toBe('active');
    expect(license).not.toBeNull();
    expect(license!.licenseKey.startsWith('SK-')).toBe(true);
    expect(license!.source).toBe('storekit');
    expect((license!.metadata as Record<string, unknown>).storekit_environment).toBe('Sandbox');
  });

  it('is idempotent: replaying the same signed transaction relinks without duplicating', async () => {
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const jws = makeJws(txnPayload());
    const first = await post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: jws, deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${token}` });
    expect(first.status).toBe(200);
    const second = await post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: jws, deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${token}` });
    expect(second.status).toBe(200);
    const { purchase } = await licenseForPurchase();
    const licCount = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM license WHERE license_key LIKE 'SK-%'`);
      return (r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    });
    expect(licCount).toBe(1);
    expect(purchase).not.toBeNull();
  });

  it('rejects a transaction whose product id is not configured for the app', async () => {
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const res = await post('/v1/shop/pro/link-storekit', {
      appKey: APP_KEY,
      signedTransactionInfo: makeJws(txnPayload({ productId: 'app.example.unmapped' })),
      deviceIdHash: DEVICE_HASH,
    }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
  });

  it('rejects a Sandbox purchase when the app policy forbids Sandbox', async () => {
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE storekit_app SET allow_sandbox = false WHERE bundle_id = ${BUNDLE_ID}`));
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const res = await post('/v1/shop/pro/link-storekit', {
      appKey: APP_KEY,
      signedTransactionInfo: makeJws(txnPayload()),
      deviceIdHash: DEVICE_HASH,
    }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
  });

  it('rejects a forged/tampered JWS', async () => {
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const jws = makeJws(txnPayload());
    const tampered = `${jws.split('.')[0]}.${b64url(Buffer.from(JSON.stringify({ ...txnPayload(), bundleId: 'com.attacker.evil' })))}.${jws.split('.')[2]}`;
    const res = await post('/v1/shop/pro/link-storekit', {
      appKey: APP_KEY, signedTransactionInfo: tampered, deviceIdHash: DEVICE_HASH,
    }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
  });

  it('requires authentication (401 without a customer session)', async () => {
    const res = await post('/v1/shop/pro/link-storekit', {
      appKey: APP_KEY, signedTransactionInfo: makeJws(txnPayload()), deviceIdHash: DEVICE_HASH,
    });
    expect(res.status).toBe(401);
  });

  it('a purchase already linked to one account cannot be claimed by another', async () => {
    const tokenA = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const tokenB = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER_B));
    const jws = makeJws(txnPayload());
    const first = await post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: jws, deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${tokenA}` });
    expect(first.status).toBe(200);
    const second = await post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: jws, deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${tokenB}` });
    expect(second.status).toBe(401);
  });
});

describe('POST /v1/webhooks/apple/storekit', () => {
  it('rejects malformed / missing signedPayload', async () => {
    const r1 = await post('/v1/webhooks/apple/storekit', {});
    expect(r1.status).toBe(400);
    const r2 = await post('/v1/webhooks/apple/storekit', { signedPayload: 'not-a-jws' });
    expect(r2.status).toBe(400);
  });

  it('rejects a notification for an unconfigured bundleId', async () => {
    const jws = makeJws({
      notificationType: 'TEST', notificationUUID: 'u-unconfigured',
      data: { environment: 'Sandbox', bundleId: 'com.unknown.app' },
      version: '2.0', signedDate: Date.now(),
    });
    const res = await post('/v1/webhooks/apple/storekit', { signedPayload: jws });
    expect(res.status).toBe(400);
  });

  it('acks TEST notifications without mutating anything', async () => {
    const jws = makeJws(notifPayload('TEST', '11111111-2222-4333-8444-555555555501'));
    const res = await post('/v1/webhooks/apple/storekit', { signedPayload: jws });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('REFUND revokes the license and purchase; replay is a no-op; REFUND_REVERSED restores', async () => {
    // Establish the purchase via the link endpoint first.
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const link = await post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: makeJws(txnPayload()), deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${token}` });
    expect(link.status).toBe(200);

    const refund = makeJws(notifPayload('REFUND', 'notif-refund-0001', txnPayload({ revocationDate: Date.now(), revocationReason: 1 })));
    const r1 = await post('/v1/webhooks/apple/storekit', { signedPayload: refund });
    expect(r1.status).toBe(200);
    let { purchase, license } = await licenseForPurchase();
    expect(license!.status).toBe('revoked');
    expect(purchase!.status).toBe('revoked');
    expect(purchase!.revocationDate).not.toBeNull();
    // Revocation cascades: activations tombstone + generation bump (RS parity).
    const tombstoned = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT state, generation FROM license_activation WHERE license_id = ${license!.id}`);
      return (r as unknown as { rows: Array<{ state: string; generation: number }> }).rows;
    });
    expect(tombstoned.every((a) => a.state === 'revoked' && a.generation === 1)).toBe(true);

    // Replay: same notificationUUID must not error or double-apply.
    const r2 = await post('/v1/webhooks/apple/storekit', { signedPayload: refund });
    expect(r2.status).toBe(200);

    const reversed = makeJws(notifPayload('REFUND_REVERSED', 'notif-reversed-0001', txnPayload()));
    const r3 = await post('/v1/webhooks/apple/storekit', { signedPayload: reversed });
    expect(r3.status).toBe(200);
    ({ purchase, license } = await licenseForPurchase());
    expect(license!.status).toBe('active');
    expect(purchase!.status).toBe('active');
    const restored = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT state FROM license_activation WHERE license_id = ${license!.id}`);
      return (r as unknown as { rows: Array<{ state: string }> }).rows;
    });
    expect(restored.every((a) => a.state === 'active')).toBe(true);
  });

  it('DID_RENEW extends the license expiresAt from the signed transaction', async () => {
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const link = await post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: makeJws(txnPayload()), deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${token}` });
    expect(link.status).toBe(200);

    const newExpiry = Date.now() + 30 * 86_400_000;
    const renew = makeJws(notifPayload('DID_RENEW', 'notif-renew-0001', txnPayload({ expiresDate: newExpiry, transactionId: 'renewed-txn-1' })));
    const res = await post('/v1/webhooks/apple/storekit', { signedPayload: renew });
    expect(res.status).toBe(200);
    const { purchase, license } = await licenseForPurchase();
    expect(license!.status).toBe('active');
    expect(Math.abs((license!.expiresAt as Date).getTime() - newExpiry)).toBeLessThan(5000);
    expect(Math.abs((purchase!.expiresAt as Date).getTime() - newExpiry)).toBeLessThan(5000);
    expect(purchase!.transactionId).toBe('renewed-txn-1');
  });

  it('a Sandbox notification is rejected when the app forbids Sandbox', async () => {
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE storekit_app SET allow_sandbox = false WHERE bundle_id = ${BUNDLE_ID}`));
    const jws = makeJws(notifPayload('TEST', 'notif-sandbox-denied'));
    const res = await post('/v1/webhooks/apple/storekit', { signedPayload: jws });
    expect(res.status).toBe(400);
  });
});

// ── De-fork plan 2.9: storekit_event stage log wired into the handlers ──────
describe('storekit_event instrumentation (de-fork 2.9)', () => {
  type Ev = { id: string; operation_id: string; stage: string; outcome: string; error: string | null; resolved_by_event_id: string | null };
  const eventRows = () => withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id, operation_id, stage, outcome, error, resolved_by_event_id FROM storekit_event ORDER BY created_at, id`);
    return (r as unknown as { rows: Ev[] }).rows;
  });
  const unresolvedApply = async () => (await eventRows()).filter((e) => e.stage === 'apply' && e.outcome === 'failed' && !e.resolved_by_event_id);

  async function linkPurchase() {
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const res = await post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: makeJws(txnPayload()), deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
  }

  it('a successful notification records verify ok then apply ok; a duplicate delivery records replay', async () => {
    const jws = makeJws(notifPayload('TEST', '11111111-2222-4333-8444-555555555510'));
    expect((await post('/v1/webhooks/apple/storekit', { signedPayload: jws })).status).toBe(200);
    expect((await post('/v1/webhooks/apple/storekit', { signedPayload: jws })).status).toBe(200);
    const rows = await eventRows();
    expect(rows.map((r) => `${r.stage}:${r.outcome}`)).toEqual(['verify:ok', 'apply:ok', 'verify:ok', 'replay:ok']);
    expect(rows[1]!.operation_id).toBe('notification:11111111-2222-4333-8444-555555555510');
    expect(rows[3]!.operation_id).toBe(rows[1]!.operation_id);
  });

  it('a tampered notification records a verify failure and no apply row', async () => {
    const jws = makeJws(notifPayload('TEST', '11111111-2222-4333-8444-555555555511'));
    const [h, p] = jws.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const tampered = `${h}.${b64url(Buffer.from(JSON.stringify({ ...payload, notificationUUID: 'forged' })))}.${jws.split('.')[2]}`;
    expect((await post('/v1/webhooks/apple/storekit', { signedPayload: tampered })).status).toBe(400);
    const rows = await eventRows();
    expect(rows.map((r) => `${r.stage}:${r.outcome}`)).toEqual(['verify:failed']);
    expect(rows[0]!.operation_id.startsWith('payload:')).toBe(true);
  });

  it('apply failures stay unresolved across verify successes until a committed apply', async () => {
    await linkPurchase();
    const refund = makeJws(notifPayload('REFUND', 'notif-refund-ev-0001', txnPayload({ revocationDate: Date.now(), revocationReason: 1 })));
    // Force the apply to throw: any UPDATE of storekit_purchase aborts.
    await pool.query(`CREATE OR REPLACE FUNCTION sk_ev_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced apply failure'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER sk_ev_fail BEFORE UPDATE ON storekit_purchase FOR EACH ROW EXECUTE FUNCTION sk_ev_fail()`);
    try {
      for (let i = 0; i < 2; i++) {
        const res = await post('/v1/webhooks/apple/storekit', { signedPayload: refund });
        expect(res.status).toBe(500); // non-2xx: Apple retries
      }
      // Both attempts verified fine; both applies failed; nothing is resolved.
      const rows = await eventRows();
      const forNotif = rows.filter((r) => r.operation_id === 'notification:notif-refund-ev-0001' || r.stage === 'verify');
      expect(forNotif.filter((r) => r.stage === 'verify' && r.outcome === 'ok').length).toBeGreaterThanOrEqual(2);
      expect(await unresolvedApply()).toHaveLength(2);
      expect((await unresolvedApply())[0]!.error).toMatch(/forced apply failure/);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS sk_ev_fail ON storekit_purchase');
      await pool.query('DROP FUNCTION IF EXISTS sk_ev_fail()');
    }
    // The retry that finally commits resolves both, in the apply transaction.
    expect((await post('/v1/webhooks/apple/storekit', { signedPayload: refund })).status).toBe(200);
    expect(await unresolvedApply()).toHaveLength(0);
    const rows = await eventRows();
    const okApply = rows.find((r) => r.stage === 'apply' && r.outcome === 'ok' && r.operation_id === 'notification:notif-refund-ev-0001')!;
    expect(rows.filter((r) => r.stage === 'apply' && r.outcome === 'failed').every((r) => r.resolved_by_event_id === okApply.id)).toBe(true);
    // A late duplicate is a replay and changes nothing.
    expect((await post('/v1/webhooks/apple/storekit', { signedPayload: refund })).status).toBe(200);
    expect((await eventRows()).at(-1)).toMatchObject({ stage: 'replay', outcome: 'ok' });
  });

  it('link-storekit records verify ok + apply ok; a bad JWS records only a verify failure', async () => {
    await linkPurchase();
    expect((await eventRows()).map((r) => `${r.stage}:${r.outcome}`)).toEqual(['verify:ok', 'apply:ok']);
    const token = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const jws = makeJws(txnPayload());
    const tampered = `${jws.split('.')[0]}.${b64url(Buffer.from(JSON.stringify({ ...txnPayload(), bundleId: 'com.attacker.evil' })))}.${jws.split('.')[2]}`;
    expect((await post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: tampered, deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${token}` })).status).toBe(400);
    const rows = await eventRows();
    expect(rows.slice(2).map((r) => `${r.stage}:${r.outcome}`)).toEqual(['verify:failed']);
  });

  it('verify-failure rows are bounded: one per payload digest per hour, and a per-(ip, app) budget (INSTR-4)', async () => {
    const mk = (i: number) => {
      const jws = makeJws(notifPayload('TEST', `11111111-2222-4333-8444-5555555556${String(i).padStart(2, '0')}`));
      const [h, p, sig] = jws.split('.');
      const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Record<string, unknown>;
      return `${h}.${b64url(Buffer.from(JSON.stringify({ ...payload, notificationUUID: `forged-${i}` })))}.${sig}`;
    };
    const same = mk(0);
    for (let i = 0; i < 5; i++) expect((await post('/v1/webhooks/apple/storekit', { signedPayload: same }, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(400);
    expect((await eventRows()).filter((r) => r.stage === 'verify' && r.outcome === 'failed')).toHaveLength(1);
    for (let i = 1; i < 40; i++) await post('/v1/webhooks/apple/storekit', { signedPayload: mk(i) }, { 'x-forwarded-for': '203.0.113.9' });
    const n = (await eventRows()).filter((r) => r.stage === 'verify' && r.outcome === 'failed').length;
    expect(n).toBeLessThanOrEqual(30);
    expect(n).toBeGreaterThan(1);
  });

  it('an instrumentation failure never rolls back the apply (savepoint) (INSTR-5)', async () => {
    await linkPurchase();
    await pool.query(`CREATE OR REPLACE FUNCTION sk_ev_block() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'event insert blocked'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER sk_ev_block BEFORE INSERT ON storekit_event FOR EACH ROW EXECUTE FUNCTION sk_ev_block()`);
    try {
      const refund = makeJws(notifPayload('REFUND', 'notif-refund-ev-0005', txnPayload({ revocationDate: Date.now(), revocationReason: 1 })));
      expect((await post('/v1/webhooks/apple/storekit', { signedPayload: refund })).status).toBe(200);
      const { purchase, license } = await licenseForPurchase();
      expect(purchase!.status).toBe('revoked');
      expect(license!.status).toBe('revoked');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS sk_ev_block ON storekit_event');
      await pool.query('DROP FUNCTION IF EXISTS sk_ev_block()');
    }
  });

  it('a definitive link refusal on retry resolves an earlier thrown apply failure (INSTR-7)', async () => {
    const tokenA = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
    const tokenB = await withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER_B));
    const jws = makeJws(txnPayload());
    const body = { appKey: APP_KEY, signedTransactionInfo: jws, deviceIdHash: DEVICE_HASH };
    expect((await post('/v1/shop/pro/link-storekit', body, { authorization: `Bearer ${tokenA}` })).status).toBe(200);
    // Plant an unresolved apply failure for this link operation, as a thrown failure would leave.
    const op = (await eventRows()).find((r) => r.stage === 'apply')!.operation_id;
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO storekit_event (store_id, operation_id, stage, outcome, error) VALUES (${STORE}, ${op}, 'apply', 'failed', 'planted')`));
    expect(await unresolvedApply()).toHaveLength(1);
    // Another account's retry is a definitive 401 refusal: it concludes the operation.
    expect((await post('/v1/shop/pro/link-storekit', body, { authorization: `Bearer ${tokenB}` })).status).toBe(401);
    expect(await unresolvedApply()).toHaveLength(0);
  });
});
