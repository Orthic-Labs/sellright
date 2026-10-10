/**
 * T-K4 golden recordings: the built-in StoreKit routes under the default policy (`sellright-default`) must
 * answer the same bytes as the pre-policy runtime. Goldens were recorded from the untouched HEAD of this
 * branch before the policy-host changes (`GOLDEN_RECORD=1` regenerates them; never do that to paper over a
 * diff). Responses are normalised only for values that are random per run (tokens, lease ids, timestamps).
 * Lane test DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withStore } from '../../db/client.js';
import { env } from '../../env.js';
import * as s from '../../db/schema.js';
import { createSession } from '../../auth/session.js';
import { storeKitWebhooks } from '../../routes/storekit-webhooks.js';
import { _setStoreKitVerifierOverrideForTests } from '../storekit-config.js';
import { createAppleFixture, type AppleFixture } from './jws-fixture.js';
import { _resetStoreKitPoliciesForTests, registerStoreKitPolicy } from './policy.js';
import { sellrightDefaultPolicy } from './default-policy.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error('storekit golden test truncates data — point DATABASE_URL at a *_test database');
}

const GOLDEN_PATH = fileURLToPath(new URL('./golden/default-responses.golden.json', import.meta.url));
const STORE = 'ffffffff-ffff-ffff-ffff-ffffffffff11';
const SLUG = 'storekit-golden-test';
const CUSTOMER = 'ffffffff-ffff-ffff-ffff-ffffffffff12';
const CUSTOMER_2 = 'ffffffff-ffff-ffff-ffff-ffffffffff13';
const BUNDLE_ID = 'app.golden.ios';
const APP_APPLE_ID = 555555555;
const APP_KEY = 'goldenapp';
const PRODUCT = 'app.golden.pro.lifetime';
const ORIG = '5000000000000001';
const DEVICE_HASH = createHash('sha256').update('golden-device').digest('hex');
const FIXED_EXPIRY = Date.parse('2031-06-01T00:00:00.000Z');

const app = new OpenAPIHono();
app.route('/', storeKitWebhooks);
let fx: AppleFixture;

function txn(over: Record<string, unknown> = {}) {
  return {
    transactionId: `t-${ORIG}`, originalTransactionId: ORIG, bundleId: BUNDLE_ID, productId: PRODUCT,
    environment: 'Sandbox', purchaseDate: Date.now(), originalPurchaseDate: Date.now(),
    signedDate: Date.now(), type: 'Non-Consumable', ...over,
  };
}
function notif(type: string, uuid: string, t?: Record<string, unknown>) {
  return fx.makeJws({
    notificationType: type, notificationUUID: uuid, version: '2.0', signedDate: Date.now(),
    data: { environment: 'Sandbox', bundleId: BUNDLE_ID, bundleVersion: '1', appAppleId: APP_APPLE_ID,
      ...(t ? { signedTransactionInfo: fx.makeJws(t) } : {}) },
  });
}
async function post(path: string, body: unknown, headers?: Record<string, string>) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, ...headers },
    body: JSON.stringify(body),
  });
}
const link = (token: string | null, signed: string, extra: Record<string, unknown> = {}) =>
  post('/v1/shop/pro/link-storekit', { appKey: APP_KEY, signedTransactionInfo: signed, deviceIdHash: DEVICE_HASH, ...extra },
    token ? { authorization: `Bearer ${token}` } : undefined);
const notify = (jws: string) => post('/v1/webhooks/apple/storekit', { signedPayload: jws });

async function seed() {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, 'Golden Test', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    for (const [id, email] of [[CUSTOMER, 'golden@example.com'], [CUSTOMER_2, 'other@example.com']] as const) {
      await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${id}, ${STORE}, ${email}) ON CONFLICT (id) DO NOTHING`);
    }
    await tx.execute(sql`INSERT INTO storekit_app (store_id, app_key, bundle_id, app_apple_id, allow_sandbox, product_map)
      VALUES (${STORE}, ${APP_KEY}, ${BUNDLE_ID}, ${APP_APPLE_ID}, true, ${JSON.stringify({ [PRODUCT]: { tier: 'pro', seats: 2 } })}::jsonb)`);
  });
}
const tokenFor = (customer: string) => withStore(STORE, (tx) => createSession(tx, STORE, customer));

/** Summary of state the route left behind; ids are not recorded, only enumerations and statuses. */
async function stateSummary() {
  return withStore(STORE, async (tx) => {
    const purchases = await tx.select({ status: s.storekitPurchase.status }).from(s.storekitPurchase);
    const licenses = await tx.select({ status: s.license.status }).from(s.license);
    const acts = await tx.select({ state: s.licenseActivation.state }).from(s.licenseActivation);
    const claims = await tx.execute(sql`SELECT count(*)::int AS n FROM processed_event WHERE store_id = ${STORE}`);
    return {
      purchases: purchases.map((p) => p.status).sort(),
      licenses: licenses.map((l) => l.status).sort(),
      activations: acts.map((a) => a.state).sort(),
      claims: (claims as unknown as { rows: { n: number }[] }).rows[0]!.n,
    };
  });
}

/** Normalise values that are random per run; everything else must match byte for byte. */
function norm(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, k)]));
  }
  if (key === 'activationToken' && typeof v === 'string') return '<token>';
  if (key === 'leaseId' && typeof v === 'string') return '<id>';
  if ((key === 'issuedAt' || key === 'expiresAt') && typeof v === 'string') return '<ts>';
  return v;
}

type Case = { name: string; setup?: () => Promise<void>; run: () => Promise<Response> };
const LINKED = async () => {
  const tok = await tokenFor(CUSTOMER);
  const r = await link(tok, fx.makeJws(txn()));
  if (r.status !== 200) throw new Error(`setup link failed: ${r.status}`);
};

const CASES: Case[] = [
  { name: 'link ok (sandbox)', run: async () => link(await tokenFor(CUSTOMER), fx.makeJws(txn())) },
  { name: 'link ok, platform hint ignored by default', run: async () => link(await tokenFor(CUSTOMER), fx.makeJws(txn()), { platform: 'macos', deviceLabel: 'Mac' }) },
  { name: 'link repeated by the same account', setup: LINKED, run: async () => link(await tokenFor(CUSTOMER), fx.makeJws(txn())) },
  { name: 'link by another account conflicts', setup: LINKED, run: async () => link(await tokenFor(CUSTOMER_2), fx.makeJws(txn())) },
  { name: 'link unauthenticated', run: async () => link(null, fx.makeJws(txn())) },
  { name: 'link unknown app key', run: async () => post('/v1/shop/pro/link-storekit', { appKey: 'nope', signedTransactionInfo: fx.makeJws(txn()), deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${await tokenFor(CUSTOMER)}` }) },
  { name: 'link wrong bundle', run: async () => link(await tokenFor(CUSTOMER), fx.makeJws(txn({ bundleId: 'app.other.ios' }))) },
  { name: 'link revoked by Apple', run: async () => link(await tokenFor(CUSTOMER), fx.makeJws(txn({ revocationDate: FIXED_EXPIRY - 5000, revocationReason: 1 }))) },
  { name: 'link tampered JWS', run: async () => link(await tokenFor(CUSTOMER), `${fx.makeJws(txn()).slice(0, -4)}AAAA`) },
  { name: 'link malformed body', run: async () => post('/v1/shop/pro/link-storekit', { appKey: APP_KEY }, { authorization: `Bearer ${await tokenFor(CUSTOMER)}` }) },
  { name: 'notification REFUND for linked purchase', setup: LINKED, run: async () => notify(notif('REFUND', 'g-refund-1', txn({ revocationDate: FIXED_EXPIRY - 5000, revocationReason: 1 }))) },
  { name: 'notification replayed UUID is a no-op', setup: async () => { await LINKED(); await notify(notif('REFUND', 'g-replay-1', txn({ revocationDate: FIXED_EXPIRY - 5000, revocationReason: 1 }))); }, run: async () => notify(notif('REFUND', 'g-replay-1', txn({ revocationDate: FIXED_EXPIRY - 5000, revocationReason: 1 }))) },
  { name: 'notification REFUND then REFUND_REVERSED', setup: async () => { await LINKED(); await notify(notif('REFUND', 'g-rr-1', txn({ revocationDate: FIXED_EXPIRY - 5000, revocationReason: 1 }))); }, run: async () => notify(notif('REFUND_REVERSED', 'g-rr-2', txn())) },
  { name: 'notification DID_RENEW for unlinked purchase materializes', run: async () => notify(notif('DID_RENEW', 'g-mat-1', txn({ expiresDate: FIXED_EXPIRY, transactionId: 'renew-m' }))) },
  { name: 'notification REFUND for unlinked purchase does not materialize', run: async () => notify(notif('REFUND', 'g-mat-2', txn({ revocationDate: FIXED_EXPIRY - 5000, revocationReason: 1 }))) },
  { name: 'notification ignored type claims only', run: async () => notify(notif('SUBSCRIBED', 'g-ign-1', txn())) },
  { name: 'notification missing signedPayload', run: async () => post('/v1/webhooks/apple/storekit', {}) },
  { name: 'notification tampered JWS', run: async () => notify(`${notif('REFUND', 'g-bad-1').slice(0, -4)}AAAA`) },
  { name: 'notification for unknown bundle', run: async () => notify(fx.makeJws({ notificationType: 'REFUND', notificationUUID: 'g-unk-1', version: '2.0', signedDate: 1, data: { bundleId: 'app.unknown.ios', environment: 'Sandbox' } })) },
];

const GOLDEN_RECORD = process.env.GOLDEN_RECORD === '1';

beforeAll(() => {
  fx = createAppleFixture(BUNDLE_ID, APP_APPLE_ID);
  _setStoreKitVerifierOverrideForTests(() => ({ production: fx.prodVerifier, sandbox: fx.sandboxVerifier }));
});
afterAll(async () => {
  _setStoreKitVerifierOverrideForTests(undefined);
  _resetStoreKitPoliciesForTests();
  registerStoreKitPolicy(sellrightDefaultPolicy);
  fx.cleanup();
  await pool.end();
});
beforeEach(async () => {
  _resetStoreKitPoliciesForTests();
  registerStoreKitPolicy(sellrightDefaultPolicy);
  await pool.query('TRUNCATE store CASCADE');
  await seed();
});

describe('default policy golden responses (T-K4)', () => {
  it('every built-in route answer and resulting state matches the recorded golden', async () => {
    const recorded: Record<string, unknown> = {};
    for (const c of CASES) {
      await pool.query('TRUNCATE store CASCADE');
      await seed();
      if (c.setup) await c.setup();
      const res = await c.run();
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }
      recorded[c.name] = { status: res.status, body: norm(body), state: await stateSummary() };
    }
    if (GOLDEN_RECORD) {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
      return;
    }
    expect(existsSync(GOLDEN_PATH)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(golden).sort());
    for (const name of Object.keys(golden)) expect(recorded[name], name).toEqual(golden[name]);
  });
});
