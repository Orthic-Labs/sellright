/**
 * StoreKit policy host through the real route and ApiPlugin.init (STOREKIT §3, §5.3, §8):
 *   - the fork-reference kit is registered by a plugin's init() inside createApp(), not at module load
 *   - the paired proof travels through linkRequestExtension and the built-in route (T-K3)
 *   - lockPlan dependents and orders join the plan (§5.3)
 *   - the dependent cascade and its tombstones (T-K12), lock-set growth (T-K5), seeded interleavings (T-K2),
 *     and no external I/O while a transaction is open (T-K9)
 * Lane test DB only. Fixtures: throwaway Apple-like CA (jws-fixture.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore, type Tx } from '../../db/client.js';
import { env } from '../../env.js';
import * as s from '../../db/schema.js';
import { LockSetUnstable, withLockedSet, type LockPlanContribution, type PurchaseId } from '../../db/locks.js';
import { createSession } from '../../auth/session.js';
import { createApp } from '../../app.js';
import { registerApiPlugin, _clearApiPluginsForTest } from '../../plugins.js';
import { storeKitWebhooks } from '../../routes/storekit-webhooks.js';
import { _setStoreKitVerifierOverrideForTests } from '../storekit-config.js';
import { createAppleFixture, type AppleFixture } from './jws-fixture.js';
import { _resetStoreKitPoliciesForTests, registerStoreKitPolicy, storeKitPolicyFor } from './policy.js';
import { sellrightDefaultPolicy } from './default-policy.js';
import { forkReferencePolicy, FORK_MESSAGE, FORK_PRODUCTS } from './fork-reference-policy.kit.js';
import { storeKitLicenseKey } from '../storekit-license.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error('storekit kit test truncates data — point DATABASE_URL at a *_test database');
}

const STORE = 'ffffffff-ffff-ffff-ffff-ffffffffff21';
const SLUG = 'storekit-kit-test';
const CUSTOMER = 'ffffffff-ffff-ffff-ffff-ffffffffff22';
const CUSTOMER_2 = 'ffffffff-ffff-ffff-ffff-ffffffffff23';
const BUNDLE_ID = 'app.kit.ios';
const APP_APPLE_ID = 424242424;
const KIT_APP = 'heardright';
const MOBILE_OTID = 'kit-mobile-1';
const UPGRADE_OTID = 'kit-upgrade-1';
const DEVICE_HASH = createHash('sha256').update('kit-device').digest('hex');
const ALLOWED = new Set([200, 400, 401, 409, 422, 503]);

const app = new OpenAPIHono();
app.route('/', storeKitWebhooks);
let fx: AppleFixture;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deterministic PRNG (mulberry32) so every interleaving is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function payload(over: Record<string, unknown>) {
  return {
    transactionId: `t-${String(over.originalTransactionId ?? 'x')}`, originalTransactionId: 'x', bundleId: BUNDLE_ID,
    productId: FORK_PRODUCTS.mobile, environment: 'Sandbox', purchaseDate: Date.now(), originalPurchaseDate: Date.now(),
    signedDate: Date.now(), type: 'Non-Consumable', appAccountToken: 'kit-token-1', ...over,
  };
}
const mobileTxn = (over: Record<string, unknown> = {}) => payload({ originalTransactionId: MOBILE_OTID, productId: FORK_PRODUCTS.mobile, ...over });
const upgradeTxn = (over: Record<string, unknown> = {}) => payload({ originalTransactionId: UPGRADE_OTID, productId: FORK_PRODUCTS.upgrade, ...over });

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
/** Link through the real route. `mobileJws` travels as the policy's signedMobileTransactionInfo field. */
function linkKit(token: string, signed: string, mobileJws?: string, extra: Record<string, unknown> = {}) {
  return post('/v1/shop/pro/link-storekit', {
    appKey: KIT_APP, signedTransactionInfo: signed, deviceIdHash: DEVICE_HASH, platform: 'ios',
    ...(mobileJws ? { signedMobileTransactionInfo: mobileJws } : {}), ...extra,
  }, { authorization: `Bearer ${token}` });
}
const notify = (jws: string) => post('/v1/webhooks/apple/storekit', { signedPayload: jws });
const errMessage = async (r: Response) => ((await r.json()) as { error?: { message?: string } }).error?.message ?? '';

async function seedKit() {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, 'Kit Test', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    for (const [id, email] of [[CUSTOMER, 'kit@example.com'], [CUSTOMER_2, 'kit2@example.com']] as const) {
      await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${id}, ${STORE}, ${email}) ON CONFLICT (id) DO NOTHING`);
    }
    await tx.execute(sql`INSERT INTO storekit_app (store_id, app_key, bundle_id, app_apple_id, allow_sandbox, product_map)
      VALUES (${STORE}, ${KIT_APP}, ${BUNDLE_ID}, ${APP_APPLE_ID}, true, ${JSON.stringify({
        [FORK_PRODUCTS.legacy]: { tier: 'pro', seats: 0 },
        [FORK_PRODUCTS.mobile]: { tier: 'mobile', seats: 0 },
        [FORK_PRODUCTS.upgrade]: { tier: 'pro', seats: 0 },
      })}::jsonb)`);
  });
}
const tokenFor = (customer: string) => withStore(STORE, (tx) => createSession(tx, STORE, customer));

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

/** One purchase identity's row and licence, by Apple original transaction id. */
async function purchaseRow(otid: string) {
  return withStore(STORE, async (tx) => {
    const [p] = await tx.select().from(s.storekitPurchase).where(and(
      eq(s.storekitPurchase.storeId, STORE), eq(s.storekitPurchase.originalTransactionId, otid),
    ));
    const [lic] = p?.licenseId ? await tx.select().from(s.license).where(eq(s.license.id, p.licenseId)) : [];
    return { purchase: p ?? null, license: lic ?? null };
  });
}
async function activationsOf(licenseId: string) {
  return withStore(STORE, (tx) => tx.select({ state: s.licenseActivation.state, generation: s.licenseActivation.generation })
    .from(s.licenseActivation).where(eq(s.licenseActivation.licenseId, licenseId)));
}
/** Upgrade licence(s) whose credit points at the given mobile licence. */
async function dependentsOf(mobileLicenseId: string) {
  return withStore(STORE, (tx) => tx.select().from(s.license).where(
    sql`${s.license.metadata}->>'mobile_upgrade_source_id' = ${mobileLicenseId}`,
  ));
}
async function linkedMobile(): Promise<string> {
  const r = await linkKit(await tokenFor(CUSTOMER), fx.makeJws(mobileTxn()));
  expect(r.status).toBe(200);
  const { license } = await purchaseRow(MOBILE_OTID);
  return license!.id;
}

beforeAll(() => {
  fx = createAppleFixture(BUNDLE_ID, APP_APPLE_ID);
  _setStoreKitVerifierOverrideForTests(() => ({ production: fx.prodVerifier, sandbox: fx.sandboxVerifier }));
});
afterAll(async () => {
  _setStoreKitVerifierOverrideForTests(undefined);
  _clearApiPluginsForTest();
  _resetStoreKitPoliciesForTests();
  registerStoreKitPolicy(sellrightDefaultPolicy);
  fx.cleanup();
  await pool.end();
});
beforeEach(async () => {
  // The kit reaches the registry only through a plugin's init(), inside createApp() (ApiPlugin.init).
  _resetStoreKitPoliciesForTests();
  _clearApiPluginsForTest();
  registerApiPlugin({ name: 'rightsuite-fork-kit', init: () => registerStoreKitPolicy(forkReferencePolicy) });
  createApp();
  await wipe();
  await seedKit();
});

describe('plugin registration through ApiPlugin.init', () => {
  it('createApp runs the plugin init: heardright is served by the kit, every other appKey by the default', () => {
    expect(storeKitPolicyFor(KIT_APP).id).toBe('rightsuite-fork-reference');
    expect(storeKitPolicyFor('exampleapp').id).toBe('sellright-default');
  });

  it('a second plugin claiming an appKey that is already served fails at startup', () => {
    _clearApiPluginsForTest();
    _resetStoreKitPoliciesForTests();
    registerApiPlugin({ name: 'kit-a', init: () => registerStoreKitPolicy(forkReferencePolicy) });
    registerApiPlugin({ name: 'kit-b', init: () => registerStoreKitPolicy({ ...forkReferencePolicy, id: 'kit-b' }) });
    expect(() => createApp()).toThrow(/already served/);
  });
});

describe('paired proof through the real route (T-K3, linkRequestExtension)', () => {
  it('an upgrade with a matching paired mobile proof links and credits the mobile licence', async () => {
    const r = await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn()), fx.makeJws(mobileTxn()));
    expect(r.status).toBe(200);
    const mobile = await purchaseRow(MOBILE_OTID);
    expect((mobile.license!.metadata as Record<string, unknown>).mobile_upgrade_storekit_key).toBeDefined();
    expect((await purchaseRow(UPGRADE_OTID)).purchase!.status).toBe('active');
  });

  it('a paired proof with a different appAccountToken is rejected with the fork invalid-purchase message', async () => {
    const r = await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn({ appAccountToken: 'other' })), fx.makeJws(mobileTxn()));
    expect(r.status).toBe(400);
    expect(await errMessage(r)).toContain(FORK_MESSAGE);
    expect((await purchaseRow(UPGRADE_OTID)).purchase).toBeNull();
  });

  it('an upgrade without a paired field is rejected before any transaction', async () => {
    const r = await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn()));
    expect(r.status).toBe(400);
    expect((await purchaseRow(UPGRADE_OTID)).purchase).toBeNull();
  });

  it('a mobile purchase already credited to another upgrade is credit_used through the route', async () => {
    expect((await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn()), fx.makeJws(mobileTxn()))).status).toBe(200);
    const second = await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn({ originalTransactionId: 'kit-upgrade-2', transactionId: 'u2' })), fx.makeJws(mobileTxn()));
    expect(second.status).toBe(400);
    expect(await errMessage(second)).toContain(FORK_MESSAGE);
  });

  it('a non-string paired field is a validation 400 from the extension schema', async () => {
    const r = await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn()), undefined, { signedMobileTransactionInfo: 12345 });
    expect(r.status).toBe(400);
    expect(await errMessage(r)).toBe('invalid link request');
  });

  it('a paired mobile purchase refunded by Apple cannot back a new upgrade', async () => {
    await linkedMobile();
    expect((await notify(notif('REFUND', 'kit-pre-refund', mobileTxn({ revocationDate: Date.now(), revocationReason: 1 })))).status).toBe(200);
    const r = await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn()), fx.makeJws(mobileTxn()));
    expect(r.status).toBe(400);
    expect((await purchaseRow(UPGRADE_OTID)).purchase).toBeNull();
  });

  it('two crossed links (A paired with B, B paired with A) both complete without deadlock', async () => {
    for (let round = 0; round < 3; round++) {
      await wipe();
      await seedKit();
      const tok = await tokenFor(CUSTOMER);
      const a = { mobile: 'cross-m-a', upgrade: 'cross-u-a', token: `tok-a-${round}` };
      const b = { mobile: 'cross-m-b', upgrade: 'cross-u-b', token: `tok-b-${round}` };
      const mk = (x: typeof a, withMobile: typeof a) => [
        fx.makeJws(payload({ originalTransactionId: x.upgrade, transactionId: `t-${x.upgrade}`, productId: FORK_PRODUCTS.upgrade, appAccountToken: x.token })),
        fx.makeJws(payload({ originalTransactionId: withMobile.mobile, transactionId: `t-${withMobile.mobile}`, productId: FORK_PRODUCTS.mobile, appAccountToken: x.token })),
      ] as const;
      const [primaryA, pairedB] = mk(a, b);
      const [primaryB, pairedA] = mk(b, a);
      const results = await Promise.all([linkKit(tok, primaryA, pairedB), linkKit(tok, primaryB, pairedA)]);
      for (const r of results) expect(r.status).toBe(200);
    }
  });
});

describe('lockPlan contributions join the set (STOREKIT §5.3)', () => {
  it('a notification on a mobile purchase plans its upgrade dependents and their orders', async () => {
    const mobileLic = await linkedMobile();
    expect((await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn()), fx.makeJws(mobileTxn()))).status).toBe(200);
    const [dep] = await dependentsOf(mobileLic);
    expect(dep).toBeDefined();
    const purchase: PurchaseId = { storeId: STORE, environment: 'Sandbox', originalTransactionId: MOBILE_OTID };
    const plan = await withLockedSet(STORE, { kind: 'notification', purchase }, async (_tx, _held, p) => p);
    expect(plan.licenseIds).toContain(dep!.id);
  });

  it('an order subject plans the upgrade source, its Apple purchase and its sibling dependents', async () => {
    const mobileLic = await linkedMobile();
    const orderId = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, metadata)
        VALUES (${STORE}, 'KIT-ORD-1', 'PendingPayment', 'USD', ${JSON.stringify({ mobile_upgrade_source_id: mobileLic })}::jsonb)
        RETURNING id`);
      return (r.rows[0] as { id: string }).id;
    });
    const plan = await withLockedSet(STORE, { kind: 'order', orderId }, async (_tx, _held, p) => p);
    expect(plan.licenseIds).toContain(mobileLic);
    expect(plan.purchases.map((p) => p.originalTransactionId)).toContain(MOBILE_OTID);
    expect(plan.orderIds).toContain(orderId);
  });
});

describe('dependent cascade and tombstones (T-K12)', () => {
  async function linkedPair() {
    const tok = await tokenFor(CUSTOMER);
    const r = await linkKit(tok, fx.makeJws(upgradeTxn()), fx.makeJws(mobileTxn()));
    expect(r.status).toBe(200);
    const mobile = await purchaseRow(MOBILE_OTID);
    const upgrade = await purchaseRow(UPGRADE_OTID);
    return { mobileLic: mobile.license!.id, upgradeLic: upgrade.license!.id };
  }

  it('revoking the mobile source revokes its upgrade dependent and tombstones both activations with a generation bump', async () => {
    const { mobileLic, upgradeLic } = await linkedPair();
    // The mobile licence also holds an activation of its own (a direct mobile link on iOS).
    expect((await linkKit(await tokenFor(CUSTOMER), fx.makeJws(mobileTxn({ transactionId: 'm-direct' })))).status).toBe(200);
    const before = await activationsOf(upgradeLic);
    const beforeMobile = await activationsOf(mobileLic);
    expect(before.every((a) => a.state === 'active')).toBe(true);

    const res = await notify(notif('REFUND', 'k-rev-1', mobileTxn({ revocationDate: Date.now(), revocationReason: 1 })));
    expect(res.status).toBe(200);
    expect((await purchaseRow(MOBILE_OTID)).license!.status).toBe('revoked');
    expect((await purchaseRow(UPGRADE_OTID)).license!.status).toBe('revoked');
    const after = await activationsOf(upgradeLic);
    expect(after.every((a) => a.state === 'revoked')).toBe(true);
    expect(after[0]!.generation).toBe(before[0]!.generation + 1);
    expect((await activationsOf(mobileLic)).every((a) => a.state === 'revoked')).toBe(true);
    expect(beforeMobile.length).toBeGreaterThan(0);
  });

  it('a replayed revoke is a no-op: no second generation bump and no new claim', async () => {
    const { upgradeLic } = await linkedPair();
    const jws = notif('REFUND', 'k-rev-replay', mobileTxn({ revocationDate: Date.now(), revocationReason: 1 }));
    expect((await notify(jws)).status).toBe(200);
    const gen = (await activationsOf(upgradeLic))[0]!.generation;
    const claims = await withStore(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM processed_event WHERE store_id = ${STORE}`));
    expect((await notify(jws)).status).toBe(200);
    expect((await activationsOf(upgradeLic))[0]!.generation).toBe(gen);
    expect(((await withStore(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM processed_event WHERE store_id = ${STORE}`))) as unknown as { rows: { n: number }[] }).rows[0]!.n)
      .toBe(((claims as unknown as { rows: { n: number }[] }).rows[0]!.n));
  });

  it('restore re-activates nothing on the heardright source and leaves the dependent revoked', async () => {
    const { mobileLic, upgradeLic } = await linkedPair();
    expect((await notify(notif('REFUND', 'k-res-1', mobileTxn({ revocationDate: Date.now(), revocationReason: 1 })))).status).toBe(200);
    expect((await notify(notif('REFUND_REVERSED', 'k-res-2', mobileTxn())))).toBeDefined();
    expect((await purchaseRow(MOBILE_OTID)).license!.status).toBe('active');
    expect((await purchaseRow(UPGRADE_OTID)).license!.status).toBe('revoked');
    expect((await activationsOf(upgradeLic)).every((a) => a.state === 'revoked')).toBe(true);
    expect((await activationsOf(mobileLic)).every((a) => a.state === 'active')).toBe(true);
  });
});

describe('lock-set growth and bounded restarts (T-K5)', () => {
  beforeEach(() => {
    _resetStoreKitPoliciesForTests();
    registerStoreKitPolicy(sellrightDefaultPolicy);
  });

  it('a dependent that appears between plan and lock restarts the set with the union', async () => {
    const mobileLic = await linkedMobile();
    let calls = 0;
    registerStoreKitPolicy({
      ...sellrightDefaultPolicy,
      id: 'grow-once',
      appKeys: ['growprobe'],
      async lockPlan(): Promise<LockPlanContribution> {
        calls += 1;
        // First (unlocked) plan sees nothing; the first plan under the lock sees the licence.
        return { purchases: [], licenseIds: calls >= 2 ? [mobileLic] : [], orderIds: [] };
      },
    });
    let seenPlanLicenses: string[] = [];
    await withLockedSet(STORE, { kind: 'checkout' }, async (_tx, _held, plan) => {
      seenPlanLicenses = plan.licenseIds.slice();
    });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(seenPlanLicenses).toContain(mobileLic);
  });

  it('a plan that never settles yields LockSetUnstable, runs no body, and leaves no advisory lock behind', async () => {
    registerStoreKitPolicy({
      ...sellrightDefaultPolicy,
      id: 'never-settles',
      appKeys: ['growprobe'],
      async lockPlan(): Promise<LockPlanContribution> {
        return { purchases: [], licenseIds: [randomUUID()], orderIds: [] };
      },
    });
    let ran = false;
    await expect(withLockedSet(STORE, { kind: 'checkout' }, async () => { ran = true; })).rejects.toBeInstanceOf(LockSetUnstable);
    expect(ran).toBe(false);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    expect(rows[0].n).toBe(0);
  });
});

describe('no external I/O while a transaction is open (T-K9)', () => {
  it('paired and primary verification run with no checked-out pool client', async () => {
    const seen: number[] = [];
    const watch = (v: unknown) => new Proxy(v as object, {
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv);
        if (typeof value !== 'function') return value;
        if (String(prop).startsWith('verifyAndDecode')) {
          return (...args: unknown[]) => {
            seen.push(pool.totalCount - pool.idleCount);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    _setStoreKitVerifierOverrideForTests(() => ({ production: watch(fx.prodVerifier) as typeof fx.prodVerifier, sandbox: watch(fx.sandboxVerifier) as typeof fx.sandboxVerifier }));
    try {
      const r = await linkKit(await tokenFor(CUSTOMER), fx.makeJws(upgradeTxn()), fx.makeJws(mobileTxn()));
      expect(r.status).toBe(200);
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen.every((n) => n === 0)).toBe(true);
    } finally {
      _setStoreKitVerifierOverrideForTests(() => ({ production: fx.prodVerifier, sandbox: fx.sandboxVerifier }));
    }
  });
});

describe('randomised interleavings: credit, revoke and restore (T-K2)', () => {
  it('50 seeded rounds: no 500 or deadlock, and no active dependent of a revoked source', async () => {
    const SEEDS = 50;
    for (let seed = 1; seed <= SEEDS; seed++) {
      await wipe();
      await seedKit();
      const tok = await tokenFor(CUSTOMER);
      expect((await linkKit(tok, fx.makeJws(mobileTxn()))).status).toBe(200);

      const pick = rng(seed);
      const ops: Array<() => Promise<Response>> = [
        () => linkKit(tok, fx.makeJws(upgradeTxn()), fx.makeJws(mobileTxn())),
        () => notify(notif('REFUND', `k-s${seed}-refund`, mobileTxn({ revocationDate: Date.now(), revocationReason: 1 }))),
        () => notify(notif('REFUND_REVERSED', `k-s${seed}-reversed`, mobileTxn())),
        () => notify(notif('REFUND', `k-s${seed}-upg`, upgradeTxn({ revocationDate: Date.now(), revocationReason: 1 }))),
      ];
      // Seeded Fisher–Yates order plus seeded start jitter: each seed is one fixed schedule.
      for (let i = ops.length - 1; i > 0; i--) {
        const j = Math.floor(pick() * (i + 1));
        [ops[i], ops[j]] = [ops[j]!, ops[i]!];
      }
      const jitter = ops.map(() => Math.floor(pick() * 6));
      const results = await Promise.all(ops.map((op, i) => sleep(jitter[i]!).then(op)));
      for (const r of results) {
        expect(r.status, `seed ${seed}`).not.toBe(500);
        expect(ALLOWED.has(r.status), `seed ${seed} status ${r.status}`).toBe(true);
      }

      const leaks = await withStore(STORE, (tx: Tx) => tx.execute(sql`
        SELECT count(*)::int AS n FROM license d JOIN license src ON src.id::text = d.metadata->>'mobile_upgrade_source_id'
        WHERE d.status = 'active' AND src.status = 'revoked'`));
      expect((leaks as unknown as { rows: { n: number }[] }).rows[0]!.n, `seed ${seed}`).toBe(0);
    }
  }, 600_000);
});

