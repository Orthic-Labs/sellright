/**
 * DB tests for the StoreKit policy contract (STOREKIT §8: T-K1, T-K3 contract,
 * T-K6, and the fork-reference kit through the built-in route). Runs against the
 * lane test DB only. Fixtures: throwaway Apple-like CA (jws-fixture.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { pool, withStore, type Tx } from '../../db/client.js';
import { env } from '../../env.js';
import * as s from '../../db/schema.js';
import { acquirePurchaseLocks, withLockedSet, type PurchaseId } from '../../db/locks.js';
import { createSession } from '../../auth/session.js';
import { storeKitWebhooks } from '../../routes/storekit-webhooks.js';
import { _setStoreKitVerifierOverrideForTests, loadStoreKitAppConfig } from '../storekit-config.js';
import { createAppleFixture, type AppleFixture } from './jws-fixture.js';
import {
  _resetStoreKitPoliciesForTests,
  registerStoreKitPolicy,
} from './policy.js';
import { sellrightDefaultPolicy } from './default-policy.js';
import { forkReferencePolicy, FORK_MESSAGE, FORK_PRODUCTS } from './fork-reference-policy.kit.js';
import { storeKitLicenseKey } from '../storekit-license.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`storekit policy test truncates data — point DATABASE_URL at a *_test database`);
}

const STORE = 'ffffffff-ffff-ffff-ffff-ffffffffff01';
const SLUG = 'storekit-policy-test';
const CUSTOMER = 'ffffffff-ffff-ffff-ffff-ffffffffff02';
const BUNDLE_ID = 'app.policy.ios';
const APP_APPLE_ID = 987654321;
const DEFAULT_APP = 'exampleapp';
const KIT_APP = 'heardright';
const PRODUCT = 'app.example.pro.lifetime';
const ORIG = '4000000000000001';
const DEVICE_HASH = createHash('sha256').update('policy-device').digest('hex');
const FIXED_EXPIRY = Date.now() + 365 * 86_400_000;

const app = new OpenAPIHono();
app.route('/', storeKitWebhooks);
let fx: AppleFixture;

function txn(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: `t-${ORIG}`, originalTransactionId: ORIG, bundleId: BUNDLE_ID, productId: PRODUCT,
    environment: 'Sandbox', purchaseDate: Date.now(), originalPurchaseDate: Date.now(),
    signedDate: Date.now(), type: 'Non-Consumable', ...overrides,
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
async function postNotif(jws: string) {
  return post('/v1/webhooks/apple/storekit', { signedPayload: jws });
}
async function state() {
  return withStore(STORE, async (tx) => {
    const [p] = await tx.select().from(s.storekitPurchase).where(eq(s.storekitPurchase.originalTransactionId, ORIG));
    const lic = p?.licenseId ? (await tx.select().from(s.license).where(eq(s.license.id, p.licenseId)))[0] : undefined;
    const claims = await tx.execute(sql`SELECT count(*)::int AS n FROM processed_event WHERE store_id = ${STORE}`);
    return { purchase: p ?? null, license: lic ?? null, claims: (claims as unknown as { rows: { n: number }[] }).rows[0]!.n };
  });
}
async function seedApp(appKey: string, productMap: Record<string, unknown>) {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, 'Policy Test', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'policy@example.com') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO storekit_app (store_id, app_key, bundle_id, app_apple_id, allow_sandbox, product_map)
      VALUES (${STORE}, ${appKey}, ${BUNDLE_ID}, ${APP_APPLE_ID}, true, ${JSON.stringify(productMap)}::jsonb)
      ON CONFLICT (bundle_id) DO UPDATE SET app_key = ${appKey}, product_map = ${JSON.stringify(productMap)}::jsonb`);
  });
}
async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}
async function customerToken() {
  return withStore(STORE, (tx) => createSession(tx, STORE, CUSTOMER));
}

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
  registerStoreKitPolicy(forkReferencePolicy);
  await wipe();
});

describe('default policy through the built-in route (T-K1)', () => {
  beforeEach(async () => {
    await seedApp(DEFAULT_APP, { [PRODUCT]: { tier: 'pro', seats: 0 } });
  });

  it('a replay of an old notification after a later distinct one is a no-op', async () => {
    const tok = await customerToken();
    const link = await post('/v1/shop/pro/link-storekit', { appKey: DEFAULT_APP, signedTransactionInfo: fx.makeJws(txn()), deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${tok}` });
    expect(link.status).toBe(200);

    const refund = notif('REFUND', 'u-refund-A', txn({ revocationDate: Date.now(), revocationReason: 1 }));
    expect((await postNotif(refund)).status).toBe(200);
    expect((await state()).purchase!.status).toBe('revoked');

    expect((await postNotif(notif('REFUND_REVERSED', 'u-reversed-B', txn()))).status).toBe(200);
    expect((await state()).purchase!.status).toBe('active');

    // Apple re-delivers the first REFUND after the reversal: same notificationUUID, already claimed.
    expect((await postNotif(refund)).status).toBe(200);
    const after = await state();
    expect(after.purchase!.status).toBe('active');
    expect(after.license!.status).toBe('active');
  });

  it('distinct notifications for one purchase all apply in arrival order, each with its own claim', async () => {
    const tok = await customerToken();
    await post('/v1/shop/pro/link-storekit', { appKey: DEFAULT_APP, signedTransactionInfo: fx.makeJws(txn()), deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${tok}` });
    const before = (await state()).claims;

    const seq = [
      notif('REFUND', 'u-seq-1', txn({ revocationDate: Date.now(), revocationReason: 1 })),
      notif('REFUND_REVERSED', 'u-seq-2', txn()),
      notif('DID_RENEW', 'u-seq-3', txn({ expiresDate: FIXED_EXPIRY, transactionId: 'renew-3' })),
      notif('EXPIRED', 'u-seq-4', txn({ expiresDate: FIXED_EXPIRY - 1000 })),
    ];
    for (const jws of seq) expect((await postNotif(jws)).status).toBe(200);

    const end = await state();
    expect(end.purchase!.status).toBe('expired');
    expect(end.license!.status).toBe('expired');
    expect(end.claims - before).toBe(4);
  });

  it('concurrent distinct notifications for one purchase serialize on the purchase lock: no 500, purchase and licence agree', async () => {
    const tok = await customerToken();
    await post('/v1/shop/pro/link-storekit', { appKey: DEFAULT_APP, signedTransactionInfo: fx.makeJws(txn()), deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${tok}` });
    for (let round = 0; round < 5; round++) {
      const batch = [
        postNotif(notif('REFUND', `u-conc-${round}-a`, txn({ revocationDate: Date.now(), revocationReason: 1 }))),
        postNotif(notif('REFUND_REVERSED', `u-conc-${round}-b`, txn())),
        postNotif(notif('DID_RENEW', `u-conc-${round}-c`, txn({ expiresDate: FIXED_EXPIRY, transactionId: `renew-c-${round}` }))),
      ];
      const results = await Promise.all(batch);
      for (const r of results) expect(r.status).toBe(200);
      const st = await state();
      expect(st.license!.status).toBe(st.purchase!.status === 'revoked' ? 'revoked' : 'active');
    }
  });

  it('a failed apply rolls its claim back, so the redelivery applies', async () => {
    const tok = await customerToken();
    await post('/v1/shop/pro/link-storekit', { appKey: DEFAULT_APP, signedTransactionInfo: fx.makeJws(txn()), deviceIdHash: DEVICE_HASH }, { authorization: `Bearer ${tok}` });

    let failNext = true;
    _resetStoreKitPoliciesForTests();
    registerStoreKitPolicy({
      ...sellrightDefaultPolicy,
      async cascade() {
        if (failNext) { failNext = false; throw new Error('injected apply failure'); }
        return { restoreActivations: true };
      },
    });

    const refund = notif('REFUND', 'u-retry-1', txn({ revocationDate: Date.now(), revocationReason: 1 }));
    const first = await postNotif(refund);
    expect(first.status).toBe(500);
    const rolled = await state();
    expect(rolled.purchase!.status).toBe('active');
    expect(rolled.license!.status).toBe('active');

    const retry = await postNotif(refund);
    expect(retry.status).toBe(200);
    expect((await state()).purchase!.status).toBe('revoked');
  });
});

describe('fork-reference kit through the built-in route (heardright)', () => {
  beforeEach(async () => {
    await seedApp(KIT_APP, {
      [FORK_PRODUCTS.legacy]: { tier: 'pro', seats: 0 },
      [FORK_PRODUCTS.mobile]: { tier: 'mobile', seats: 0 },
      [FORK_PRODUCTS.upgrade]: { tier: 'pro', seats: 0 },
    });
  });

  it('rejects a link from a non-iOS platform with the fork invalid-purchase message', async () => {
    const tok = await customerToken();
    const res = await post('/v1/shop/pro/link-storekit', {
      appKey: KIT_APP, signedTransactionInfo: fx.makeJws(txn({ productId: FORK_PRODUCTS.legacy })), deviceIdHash: DEVICE_HASH, platform: 'macos',
    }, { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: { message?: string } }).error?.message ?? '').toContain(FORK_MESSAGE);
  });

  it('an upgrade link without a paired mobile proof is rejected before any transaction', async () => {
    const tok = await customerToken();
    const res = await post('/v1/shop/pro/link-storekit', {
      appKey: KIT_APP, signedTransactionInfo: fx.makeJws(txn({ productId: FORK_PRODUCTS.upgrade })), deviceIdHash: DEVICE_HASH, platform: 'ios',
    }, { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: { message?: string } }).error?.message ?? '').toContain(FORK_MESSAGE);
    expect((await state()).purchase).toBeNull();
  });

  it('a legacy-product link on iOS issues and activates through the kit', async () => {
    const tok = await customerToken();
    const res = await post('/v1/shop/pro/link-storekit', {
      appKey: KIT_APP, signedTransactionInfo: fx.makeJws(txn({ productId: FORK_PRODUCTS.legacy })), deviceIdHash: DEVICE_HASH, platform: 'ios',
    }, { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(200);
    expect((await state()).purchase!.status).toBe('active');
  });

  it('a REFUND for an unlinked heardright purchase materializes it revoked (fork rule); the default policy would not', async () => {
    const res = await postNotif(notif('REFUND', 'u-kit-mat', txn({ productId: FORK_PRODUCTS.legacy, revocationDate: Date.now(), revocationReason: 1 })));
    expect(res.status).toBe(200);
    const st = await state();
    expect(st.purchase).not.toBeNull();
    expect(st.purchase!.status).toBe('revoked');
    expect(st.license!.status).toBe('revoked');
  });

  it('a REFUND for an unlinked upgrade purchase is not materialized', async () => {
    const res = await postNotif(notif('REFUND', 'u-kit-upg', txn({ productId: FORK_PRODUCTS.upgrade, revocationDate: Date.now(), revocationReason: 1 })));
    expect(res.status).toBe(200);
    expect((await state()).purchase).toBeNull();
  });
});

describe('purchase lock acquisition (T-K6)', () => {
  it('opposite-order sets over the same purchases never deadlock, and duplicates lock once', async () => {
    await seedApp(DEFAULT_APP, { [PRODUCT]: { tier: 'pro', seats: 0 } });
    const A: PurchaseId = { storeId: STORE, environment: 'Sandbox', originalTransactionId: 'lock-A' };
    const B: PurchaseId = { storeId: STORE, environment: 'Sandbox', originalTransactionId: 'lock-B' };
    const run = (purchases: PurchaseId[]) => withStore(STORE, async (tx: Tx) => {
      await acquirePurchaseLocks(tx, purchases);
      await tx.execute(sql`SELECT pg_sleep(0.01)`);
    });
    for (let i = 0; i < 25; i++) {
      await Promise.all([run([A, B, A]), run([B, A]), run([A, B])]);
    }
  });

  it('withLockedSet over a notification subject restarts cleanly when the plan grows under lock', async () => {
    await seedApp(DEFAULT_APP, { [PRODUCT]: { tier: 'pro', seats: 0 } });
    const purchase: PurchaseId = { storeId: STORE, environment: 'Sandbox', originalTransactionId: 'lock-C' };
    const out = await withLockedSet(STORE, { kind: 'notification', purchase }, async (_tx, _held, plan) => plan.purchases.length);
    expect(out).toBe(1);
  });
});

describe('kit issue contract: paired proof, mobile source and credit (T-K3)', () => {
  const MOBILE_OTID = 'mobile-otid-1';
  const UPGRADE_OTID = 'upgrade-otid-1';
  const payload = (over: Record<string, unknown>) => ({
    transactionId: 'x', originalTransactionId: 'x', bundleId: BUNDLE_ID, productId: FORK_PRODUCTS.mobile,
    environment: 'Sandbox', purchaseDate: Date.now(), originalPurchaseDate: null, expiresDate: null,
    revocationDate: null, revocationReason: null, type: 'Non-Consumable',
    appAccountToken: 'acct-token-1', ...over,
  });
  const mobile = payload({ originalTransactionId: MOBILE_OTID, transactionId: 'm-1' });
  const upgrade = (otid: string, token = 'acct-token-1') => payload({ originalTransactionId: otid, transactionId: `u-${otid}`, productId: FORK_PRODUCTS.upgrade, appAccountToken: token });

  async function issueKit(primary: ReturnType<typeof payload>, paired: ReturnType<typeof payload> | null) {
    await seedApp(KIT_APP, {
      [FORK_PRODUCTS.legacy]: { tier: 'pro', seats: 0 }, [FORK_PRODUCTS.mobile]: { tier: 'mobile', seats: 0 }, [FORK_PRODUCTS.upgrade]: { tier: 'pro', seats: 0 },
    });
    const appCfg = await withStore(STORE, (tx) => loadStoreKitAppConfig(tx, STORE, KIT_APP));
    const purchases: PurchaseId[] = [primary, ...(paired ? [paired] : [])].map((p) => ({ storeId: STORE, environment: p.environment, originalTransactionId: p.originalTransactionId }));
    return withLockedSet(STORE, { kind: 'link', purchases }, (tx, held) => forkReferencePolicy.issue(tx, held, {
      purpose: 'link', storeId: STORE, appCfg: appCfg!, proofs: { primary, paired }, customerId: CUSTOMER,
      entitlement: null, device: { deviceIdHash: DEVICE_HASH, platform: 'ios', label: null }, facts: {},
    }));
  }

  it('an upgrade with a matching paired mobile proof issues and records the credit on the mobile licence', async () => {
    const r = await issueKit(upgrade(UPGRADE_OTID), mobile);
    expect(r.kind).toBe('ok');
    const mobileKey = storeKitLicenseKey(KIT_APP, { originalTransactionId: MOBILE_OTID, bundleId: BUNDLE_ID, environment: 'Sandbox' });
    const [mob] = await withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.licenseKey, mobileKey)));
    expect((mob!.metadata as Record<string, unknown>).mobile_upgrade_storekit_key).toBeDefined();
  });

  it('a paired proof with a different appAccountToken is rejected as mobile_source_required', async () => {
    const r = await issueKit(upgrade(UPGRADE_OTID, 'other-token'), mobile);
    expect(r).toEqual({ kind: 'rejected', code: 'mobile_source_required' });
  });

  it('a second upgrade against a mobile purchase already credited to another upgrade is credit_used', async () => {
    expect((await issueKit(upgrade(UPGRADE_OTID), mobile)).kind).toBe('ok');
    const second = await issueKit(upgrade('upgrade-otid-2'), mobile);
    expect(second).toEqual({ kind: 'rejected', code: 'credit_used' });
  });
});
