/**
 * Behaviour matrix for the entitlement authorization policy (plan 3.6).
 *
 * Enumerates PATH x POLICY DECISION against the REAL engine functions and
 * routes, on a *_test database, and asserts:
 *   1. every granting/refreshing path consults the policy exactly once with
 *      its own path id (alias paths included);
 *   2. each decision maps to the documented outcome per path;
 *   3. the default policy (nothing registered) is a no-op;
 *   4. the RightSites fork rules (COMPAT C10-C12), expressed as a policy
 *      (entitlement-policy.fork-reference.testkit.ts), reproduce the fork's
 *      observable results on every path.
 * Matrix table of record: docs/policies/ENTITLEMENTS.md.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';
import { appKeyHeaderNames, deviceHeaderName } from './app-headers.js';
import { _resetSigningKeyCache } from './sign.js';
import { clearDevicePolicies, registerDevicePolicy } from './device-policy.js';
import { issueDeviceLease, renewDeviceLease } from './device-leases.js';
import { activateLicenseOnDevice, findActivationByToken } from './activations.js';
import { issueStoreKitActivation } from './storekit-license.js';
import { recordLicenseAction } from '../routes/apps.limit.js';
import {
  ALLOW, DENY_NOTFOUND, ENTITLEMENT_PATHS, authorizeEntitlement, clearEntitlementPolicy, denyPlatform,
  registerEntitlementPolicy, type EntitlementPath, type EntitlementPolicy, type PolicyDecision,
} from './entitlement-policy.js';
import { forkReferencePolicy, MOBILE_ONLY_REASON, SANDBOX_WINDOWS_LINK_REASON } from './entitlement-policy.fork-reference.testkit.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`entitlement-policy matrix truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const APP = 'matrixapp';
const HR = 'heardright';
const hashish = (label: string) => `${label}${'0'.repeat(64 - label.length)}`;
const json = { 'content-type': 'application/json' };

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seedStore(slug: string, id = STORE) {
  await withStore(id, (tx) => tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
    VALUES (${id}, ${slug}, ${slug}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`));
}
async function seedLicense(appKey: string, metadata: Record<string, unknown> = { tier: 'pro' }, seats = 2) {
  const key = `MX-${randomUUID()}`;
  await withStore(STORE, (tx) => tx.execute(sql`
    INSERT INTO license (id, store_id, app_key, license_key, status, seats, metadata, source)
    VALUES (gen_random_uuid(), ${STORE}, ${appKey}, ${key}, 'active'::license_status, ${seats}, ${JSON.stringify(metadata)}::jsonb, 'admin')`));
  return key;
}

/** A policy that records every consultation and answers from `decide`. */
function recorder(decide: (path: EntitlementPath) => PolicyDecision) {
  const seen: EntitlementPath[] = [];
  const policy: EntitlementPolicy = {
    id: 'recorder',
    authorize: (ctx) => { seen.push(ctx.path); return decide(ctx.path); },
    trial: (ctx) => { seen.push(ctx.outcome === 'start' ? 'trial_start' : 'trial_resend'); return { days: 14 }; },
  };
  return { seen, policy };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('ed25519');
  process.env.LICENSE_SIGNING_KEY = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/\n/g, '\\n');
  _resetSigningKeyCache();
});
beforeEach(async () => {
  invalidateStoreCache();
  await wipe();
  await seedStore(APP);
  clearDevicePolicies();
  registerDevicePolicy(APP, { marker: 'matrix_v1', poolCaps: { computer: 2, mobile: 2 }, pooledSeats: true });
  registerDevicePolicy(HR, { marker: 'matrix_hr_v1', poolCaps: { computer: 2, mobile: 2 }, pooledSeats: true });
});
afterEach(async () => { clearEntitlementPolicy(); clearDevicePolicies(); await wipe(); });
afterAll(async () => { delete process.env.LICENSE_SIGNING_KEY; _resetSigningKeyCache(); await pool.end(); });

describe('policy consulted by every path (and alias)', () => {
  it('activate: /api, /v1 alias and path-param route each consult path "activate" once', async () => {
    const app = createApp();
    for (const route of ['/api/licenses/activate', '/v1/licenses/activate']) {
      const key = await seedLicense(APP);
      const { seen, policy } = recorder(() => ALLOW);
      registerEntitlementPolicy(policy);
      const res = await post(app, route, { app: APP, deviceId: `d-${route}`, licenseKey: key });
      expect(res.status, route).toBe(200);
      expect(seen, route).toEqual(['activate']);
    }
    const key = await seedLicense(APP);
    const { seen, policy } = recorder(() => ALLOW);
    registerEntitlementPolicy(policy);
    const res = await post(app, `/v1/apps/${APP}/licenses/activate`, { licenseKey: key, deviceId: 'd-param' }, { 'x-store-slug': APP });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['activate']);
  });

  it('refresh: both aliases consult "refresh"; update feed consults "update_feed"', async () => {
    const app = createApp();
    const key = await seedLicense(APP);
    const act = (await (await post(app, '/api/licenses/activate', { app: APP, deviceId: 'd-r', licenseKey: key })).json()) as { activationToken: string };
    for (const route of ['/api/licenses/refresh', '/v1/licenses/refresh']) {
      const { seen, policy } = recorder(() => ALLOW);
      registerEntitlementPolicy(policy);
      const res = await post(app, route, { app: APP, activationToken: act.activationToken, deviceId: 'd-r' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
      expect(seen, route).toEqual(['refresh']);
    }
    const { seen, policy } = recorder(() => ALLOW);
    registerEntitlementPolicy(policy);
    const feed = await app.request('/releases/latest.json', {
      headers: { authorization: `Bearer ${act.activationToken}`, [appKeyHeaderNames()[0]!]: APP, 'x-store-slug': APP, [deviceHeaderName()]: 'd-r' },
    });
    expect(feed.status).toBe(404); // reached the release lookup: policy allowed, no release seeded
    expect(seen).toEqual(['update_feed']);
  });

  it('leases: issue consults "lease_issue", renew consults "lease_renew"', async () => {
    const key = await seedLicense(APP);
    const { seen, policy } = recorder(() => ALLOW);
    registerEntitlementPolicy(policy);
    const issued = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: APP, licenseKey: key, deviceIdHash: hashish('a'), platform: 'macos' }));
    expect(issued.kind).toBe('ok');
    if (issued.kind !== 'ok') return;
    const renewed = await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: APP, deviceIdHash: hashish('a'), leaseId: issued.lease.leaseId }));
    expect(renewed.kind).toBe('ok');
    expect(seen).toEqual(['lease_issue', 'lease_renew']);
  });

  it('trial: start and resend are separate policy paths, on both aliases', async () => {
    const app = createApp();
    const { seen, policy } = recorder(() => ALLOW);
    registerEntitlementPolicy(policy);
    expect((await post(app, '/api/licenses/trial', { app: APP, email: `a-${randomUUID()}@example.com` })).status).toBe(200);
    const email = `b-${randomUUID()}@example.com`;
    expect((await post(app, '/v1/licenses/trial', { app: APP, email })).status).toBe(200);
    expect((await post(app, '/api/licenses/trial', { app: APP, email })).status).toBe(200);
    expect(seen).toEqual(['trial_start', 'trial_start', 'trial_resend']);
  });

  it('storekit_link: issueStoreKitActivation consults path "storekit_link" before minting a token', async () => {
    const key = await seedLicense(APP);
    const { seen, policy } = recorder(() => ALLOW);
    registerEntitlementPolicy(policy);
    const ok = await withStore(STORE, (tx) => issueStoreKitActivation(tx, { storeId: STORE, appKey: APP, licenseKey: key, deviceIdHash: hashish('sk1') }));
    expect(ok.kind).toBe('ok');
    expect(seen).toEqual(['storekit_link']);
    for (const [decision, kind] of [[DENY_NOTFOUND, 'notfound'], [denyPlatform('nope'), 'rejected_platform']] as const) {
      registerEntitlementPolicy(recorder(() => decision).policy);
      const out = await withStore(STORE, (tx) => issueStoreKitActivation(tx, { storeId: STORE, appKey: APP, licenseKey: key, deviceIdHash: hashish(`sk-${kind}`) }));
      expect(out.kind).toBe(kind);
    }
    const rows = await withStore(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM license_activation`));
    expect((rows.rows[0] as { n: number }).n).toBe(1); // denials left no activation row
  });

  it('windows_link is consultable by the plugin through the same entry point', async () => {
    const { seen, policy } = recorder(() => denyPlatform('x'));
    registerEntitlementPolicy(policy);
    const d = await withStore(STORE, (tx) => authorizeEntitlement({
      path: 'windows_link', tx, storeId: STORE, ext: {}, now: new Date(),
      license: { id: 'l', appKey: APP, status: 'active', seats: 0, expiresAt: null, metadata: {} },
    }));
    expect(d).toEqual({ allow: false, kind: 'rejected_platform', reason: 'x' });
    expect(seen).toEqual(['windows_link']);
  });

  it('every declared path has a row in this matrix', () => {
    expect([...ENTITLEMENT_PATHS].sort()).toEqual(
      ['activate', 'lease_issue', 'lease_renew', 'refresh', 'storekit_link', 'trial_resend', 'trial_start', 'update_feed', 'windows_link']);
  });
});

describe('decision x path outcomes', () => {
  const DECISIONS: Array<[string, PolicyDecision]> = [
    ['allow', ALLOW], ['deny notfound', DENY_NOTFOUND], ['deny rejected_platform', denyPlatform('policy says no')],
  ];

  it.each(DECISIONS)('activate (%s)', async (name, decision) => {
    const key = await seedLicense(APP);
    registerEntitlementPolicy(recorder(() => decision).policy);
    const res = await post(createApp(), '/api/licenses/activate', { app: APP, deviceId: 'd-m', licenseKey: key });
    const expected = { allow: [200, 'Activated'], 'deny notfound': [404, 'License not found or inactive'], 'deny rejected_platform': [400, 'policy says no'] }[name]!;
    expect(res.status).toBe(expected[0]);
    expect(((await res.json()) as { message: string }).message).toBe(expected[1]);
    const rows = await withStore(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM license_activation`));
    expect((rows.rows[0] as { n: number }).n).toBe(name === 'allow' ? 1 : 0); // a denial never leaves an activation row
  });

  it.each(DECISIONS)('refresh + update_feed (%s)', async (name, decision) => {
    const app = createApp();
    const key = await seedLicense(APP);
    const act = (await (await post(app, '/api/licenses/activate', { app: APP, deviceId: 'd-m2', licenseKey: key })).json()) as { activationToken: string };
    registerEntitlementPolicy(recorder(() => decision).policy);
    const ref = await post(app, '/v1/licenses/refresh', { app: APP, activationToken: act.activationToken, deviceId: 'd-m2' });
    expect(ref.status).toBe(200);
    expect(((await ref.json()) as { ok: boolean }).ok).toBe(name === 'allow');
    const feed = await app.request('/releases/latest.json', {
      headers: { authorization: `Bearer ${act.activationToken}`, [appKeyHeaderNames()[0]!]: APP, 'x-store-slug': APP, [deviceHeaderName()]: 'd-m2' },
    });
    expect(feed.status).toBe(name === 'allow' ? 404 : 401);
  });

  it.each(DECISIONS)('lease_issue + lease_renew (%s)', async (name, decision) => {
    const key = await seedLicense(APP);
    // Seed an existing lease under the default policy so renew has a subject.
    const base = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: APP, licenseKey: key, deviceIdHash: hashish('seed'), platform: 'macos' }));
    if (base.kind !== 'ok') throw new Error('seed lease failed');
    registerEntitlementPolicy(recorder(() => decision).policy);
    const issue = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: APP, licenseKey: key, deviceIdHash: hashish('new'), platform: 'macos' }));
    expect(issue.kind).toBe({ allow: 'ok', 'deny notfound': 'notfound', 'deny rejected_platform': 'rejected_platform' }[name]);
    if (issue.kind === 'rejected_platform') expect(issue.reason).toBe('policy says no');
    const renew = await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: APP, deviceIdHash: hashish('seed'), leaseId: base.lease.leaseId }));
    expect(renew.kind).toBe(name === 'allow' ? 'ok' : 'revoked');
  });

  it('a denied lease renew does not rotate the lease id', async () => {
    const key = await seedLicense(APP);
    const base = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: APP, licenseKey: key, deviceIdHash: hashish('seed'), platform: 'macos' }));
    if (base.kind !== 'ok') throw new Error('seed lease failed');
    registerEntitlementPolicy(recorder(() => DENY_NOTFOUND).policy);
    expect((await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: APP, deviceIdHash: hashish('seed'), leaseId: base.lease.leaseId }))).kind).toBe('revoked');
    clearEntitlementPolicy();
    expect((await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: APP, deviceIdHash: hashish('seed'), leaseId: base.lease.leaseId }))).kind).toBe('ok');
  });
});

describe('default policy is a no-op', () => {
  it('activation, refresh, leases and a 14-day trial behave as before the policy existed', async () => {
    const app = createApp();
    const key = await seedLicense(APP, { tier: 'pro', storekit_environment: 'Sandbox', entitlement_scope: 'mobile' });
    const act = await post(app, '/api/licenses/activate', { app: APP, deviceId: 'd-def', licenseKey: key });
    expect(act.status).toBe(200); // sandbox + mobile metadata mean nothing without a policy
    const lease = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: APP, licenseKey: key, deviceIdHash: hashish('def'), platform: 'windows' }));
    expect(lease.kind).toBe('ok');
    if (lease.kind === 'ok') expect(lease.lease).not.toHaveProperty('entitlementScope');
    const trial = await post(app, '/api/licenses/trial', { app: APP, email: `t-${randomUUID()}@example.com`, platform: 'macos' });
    expect(((await trial.json()) as { message: string }).message).toBe('Check your email for your 14-day Pro key.');
  });

  it('an invalid typed extension is rejected (400) only when a policy declares it', async () => {
    const app = createApp();
    const email = () => `x-${randomUUID()}@example.com`;
    expect((await post(app, '/api/licenses/trial', { app: APP, email: email(), platform: 'plan9' })).status).toBe(200);
    registerEntitlementPolicy({ ...forkReferencePolicy(), invalidExtension: undefined });
    const bad = await post(app, '/api/licenses/trial', { app: APP, email: email(), platform: 'plan9' });
    expect(bad.status).toBe(400); // SellRight default: clean 400
    registerEntitlementPolicy(forkReferencePolicy()); // fork opt-in: legacy 500
    const legacy = await post(app, '/api/licenses/trial', { app: APP, email: email(), platform: 'plan9' });
    expect(legacy.status).toBe(500);
  });
});

describe('RightSites fork behaviour reproduced by the policy (COMPAT C10-C12)', () => {
  const fork = (validUpgrade?: (...a: never[]) => Promise<boolean>) =>
    registerEntitlementPolicy(forkReferencePolicy(validUpgrade ? { validUpgrade: validUpgrade as never } : {}));
  const SANDBOX = { tier: 'pro', storekit_environment: 'Sandbox' };
  const MOBILE = { tier: 'pro', entitlement_scope: 'mobile', storekit_environment: 'Production' };

  beforeEach(async () => { await withStore(STORE, (tx) => tx.execute(sql`UPDATE store SET slug = ${HR} WHERE id = ${STORE}`)); invalidateStoreCache(); });

  it('legacy activate: sandbox-origin and mobile-scope licenses are 404 not_found; Production full is 200', async () => {
    fork();
    const app = createApp();
    for (const [meta, status] of [[SANDBOX, 404], [MOBILE, 404], [{ tier: 'pro' }, 200]] as const) {
      const key = await seedLicense(HR, meta);
      const res = await post(app, '/v1/licenses/activate', { app: HR, deviceId: 'd-f', licenseKey: key });
      expect(res.status).toBe(status);
      if (status === 404) expect(await res.json()).toEqual({ ok: false, status: 'not_found', message: 'License not found or inactive' });
    }
  });

  it('Watch deviceClass: 400 BEFORE rate limit / store / license lookup, on /api, /v1 and the path-param route', async () => {
    fork();
    const app = createApp();
    const good = await seedLicense(HR);
    const routes: Array<[string, (b: Record<string, unknown>) => Response | Promise<Response>]> = [
      ['/api/licenses/activate', (b) => post(app, '/api/licenses/activate', b)],
      ['/v1/licenses/activate', (b) => post(app, '/v1/licenses/activate', b)],
      ['/v1/apps/heardright/licenses/activate', (b) => post(app, `/v1/apps/${HR}/licenses/activate`, b, { 'x-store-slug': HR })],
    ];
    for (const [name, call] of routes) {
      const base = { app: HR, deviceId: 'w1', deviceClass: 'watch' };
      const withKey = (licenseKey: string) => name.includes('/apps/') ? { licenseKey, deviceId: 'w1', deviceClass: 'watch' } : { ...base, licenseKey };
      // valid key, unknown key: both 400 with the legacy text (unknown key would be 404 without the guard)
      for (const licenseKey of [good, 'NO-SUCH-KEY']) {
        const res = await call(withKey(licenseKey));
        expect(res.status, `${name} ${licenseKey}`).toBe(400);
        expect(JSON.stringify(await res.json())).toContain('the Watch app never activates a license directly');
      }
      // watch requests never consume the rate limit: 25 of them, then a normal request still works
      const key = await seedLicense(HR);
      for (let i = 0; i < 25; i++) expect((await call(withKey(key))).status).toBe(400);
      // while the (ip,key) limiter is already tripped, watch still answers 400, not 429
      const tripped = await seedLicense(HR);
      const ip = '127.0.0.1';
      for (let i = 0; i < 25; i++) await recordLicenseAction(ip, tripped);
      expect((await call(withKey(tripped))).status, `${name} while limited`).toBe(400);
    }
    // unknown app: 400 on the public routes (store is never resolved)
    expect((await post(app, '/v1/licenses/activate', { app: 'no-such-app', deviceId: 'w1', licenseKey: 'x', deviceClass: 'watch' })).status).toBe(400);
    // a non-watch request on the same license is unaffected
    expect((await post(app, '/v1/licenses/activate', { app: HR, deviceId: 'ok1', licenseKey: good, deviceClass: 'mac' })).status).toBe(200);
  });

  it('storekit link: sandbox on mobile is valid; mobile-scope with an iOS hint is valid; invalid upgrade credit is refused', async () => {
    fork(async () => true);
    const sbx = await seedLicense(HR, SANDBOX);
    const out = await withStore(STORE, (tx) => issueStoreKitActivation(tx, { storeId: STORE, appKey: HR, licenseKey: sbx, deviceIdHash: hashish('k1'), platform: 'ios' }));
    expect(out.kind).toBe('ok');
    const mob = await seedLicense(HR, MOBILE);
    expect((await withStore(STORE, (tx) => issueStoreKitActivation(tx, { storeId: STORE, appKey: HR, licenseKey: mob, deviceIdHash: hashish('k2') }))).kind).toBe('ok');
    expect(await withStore(STORE, (tx) => issueStoreKitActivation(tx, { storeId: STORE, appKey: HR, licenseKey: mob, deviceIdHash: hashish('k3'), platform: 'macos' })))
      .toEqual({ kind: 'rejected_platform', reason: MOBILE_ONLY_REASON });
    clearEntitlementPolicy();
    fork(async () => false);
    const k = await seedLicense(HR);
    expect((await withStore(STORE, (tx) => issueStoreKitActivation(tx, { storeId: STORE, appKey: HR, licenseKey: k, deviceIdHash: hashish('k4') }))).kind).toBe('notfound');
  });

  it('refresh: an activation whose license later became sandbox-origin gets {ok:false,status:invalid} with HTTP 200', async () => {
    const app = createApp();
    const key = await seedLicense(HR);
    const act = (await (await post(app, '/api/licenses/activate', { app: HR, deviceId: 'd-rf', licenseKey: key })).json()) as { activationToken: string };
    fork();
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE license SET metadata = ${JSON.stringify(SANDBOX)}::jsonb WHERE license_key = ${key}`));
    const res = await post(app, '/api/licenses/refresh', { app: HR, activationToken: act.activationToken, deviceId: 'd-rf' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, status: 'invalid', message: 'License is no longer active' });
  });

  it('lease issue: sandbox on a computer pool and mobile scope on a computer are rejected with the fork text; mobile pools stay valid', async () => {
    fork();
    const sandboxKey = await seedLicense(HR, SANDBOX);
    const mobileKey = await seedLicense(HR, MOBILE);
    const issue = (licenseKey: string, platform: string, label: string) => withStore(STORE, (tx) =>
      issueDeviceLease(tx, { storeId: STORE, appKey: HR, licenseKey, deviceIdHash: hashish(label), platform }));
    expect(await issue(sandboxKey, 'windows', 's1')).toEqual({ kind: 'rejected_platform', reason: MOBILE_ONLY_REASON });
    expect(await issue(mobileKey, 'macos', 'm1')).toEqual({ kind: 'rejected_platform', reason: MOBILE_ONLY_REASON });
    expect((await issue(sandboxKey, 'ios', 's2')).kind).toBe('ok'); // TestFlight use stays valid
    const mobileLease = await issue(mobileKey, 'ipados', 'm2');
    expect(mobileLease.kind).toBe('ok');
    if (mobileLease.kind === 'ok') expect(mobileLease.lease.entitlementScope).toBe('mobile'); // scope claim on envelope
  });

  it('lease issue: invalid upgrade license is notfound; HeardRight mobile pool is unlimited, computer is capped at 2', async () => {
    fork(async () => false);
    const k = await seedLicense(HR);
    expect((await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: HR, licenseKey: k, deviceIdHash: hashish('u1'), platform: 'macos' }))).kind).toBe('notfound');
    clearEntitlementPolicy();
    fork();
    const key = await seedLicense(HR);
    const kinds: string[] = [];
    for (const [i, platform] of ['ios', 'ios', 'ios', 'ipados'].entries()) {
      kinds.push((await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: HR, licenseKey: key, deviceIdHash: hashish(`mob${i}`), platform }))).kind);
    }
    expect(kinds).toEqual(['ok', 'ok', 'ok', 'ok']); // cap is 2 but mobile is unlimited under the fork policy
    const comp: string[] = [];
    for (const [i, platform] of ['macos', 'windows', 'macos'].entries()) {
      comp.push((await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: HR, licenseKey: key, deviceIdHash: hashish(`cmp${i}`), platform }))).kind);
    }
    expect(comp).toEqual(['ok', 'ok', 'full']);
  });

  it('lease renew: a license that became sandbox-origin cannot renew a computer lease (revoked); signed token carries the scope claim', async () => {
    const key = await seedLicense(HR);
    const base = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: HR, licenseKey: key, deviceIdHash: hashish('rn'), platform: 'macos' }));
    if (base.kind !== 'ok') throw new Error('seed');
    fork();
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE license SET metadata = ${JSON.stringify(SANDBOX)}::jsonb WHERE license_key = ${key}`));
    expect((await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: HR, deviceIdHash: hashish('rn'), leaseId: base.lease.leaseId }))).kind).toBe('revoked');

    const mkey = await seedLicense(HR, MOBILE);
    const mlease = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: HR, licenseKey: mkey, deviceIdHash: hashish('mr'), platform: 'ios' }));
    if (mlease.kind !== 'ok') throw new Error('seed mobile');
    const renewed = await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: HR, deviceIdHash: hashish('mr'), leaseId: mlease.lease.leaseId }));
    expect(renewed.kind).toBe('ok');
    if (renewed.kind !== 'ok') return;
    expect(renewed.lease.entitlementScope).toBe('mobile');
    const claims = JSON.parse(Buffer.from(renewed.lease.entitlement!.split('.')[0]!, 'base64url').toString('utf8'));
    expect(claims.entitlement_scope).toBe('mobile');
    expect(claims.v).toBe(2);
  });

  it('windows link: sandbox-origin licenses are refused with the fork text', async () => {
    fork();
    const ask = (metadata: unknown) => withStore(STORE, (tx) => authorizeEntitlement({
      path: 'windows_link', tx, storeId: STORE, ext: {}, now: new Date(),
      license: { id: 'l', appKey: HR, status: 'active', seats: 0, expiresAt: null, metadata },
    }));
    expect(await ask(SANDBOX)).toEqual({ allow: false, kind: 'rejected_platform', reason: SANDBOX_WINDOWS_LINK_REASON });
    expect(await ask({ tier: 'pro' })).toEqual({ allow: true });
  });

  it('trial: HeardRight macOS = 30 days, windows/ios/none = 14; persisted platform decides resend; other apps always 14 but persist platform', async () => {
    fork();
    const app = createApp();
    const msg = async (body: Record<string, unknown>) => ((await (await post(app, '/api/licenses/trial', body)).json()) as { message: string }).message;
    const mac = `m-${randomUUID()}@example.com`;
    expect(await msg({ app: HR, email: mac, platform: 'macos' })).toBe('Check your email for your 30-day Pro key.');
    // Resend with a DIFFERENT requested platform: the persisted one (macos) still decides.
    expect(await msg({ app: HR, email: mac, platform: 'windows' })).toBe('Check your email for your 30-day Pro key.');
    expect(await msg({ app: HR, email: `w-${randomUUID()}@example.com`, platform: 'windows' })).toBe('Check your email for your 14-day Pro key.');
    expect(await msg({ app: HR, email: `i-${randomUUID()}@example.com`, platform: 'ios' })).toBe('Check your email for your 14-day Pro key.');
    expect(await msg({ app: HR, email: `n-${randomUUID()}@example.com` })).toBe('Check your email for your 14-day Pro key.');

    await seedStore('otherapp', 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    const other = `o-${randomUUID()}@example.com`;
    expect(await msg({ app: 'otherapp', email: other, platform: 'macos' })).toBe('Check your email for your 14-day Pro key.');
    const row = await withStore('ffffffff-ffff-4fff-8fff-ffffffffffff', (tx) => tx.execute(sql`
      SELECT metadata, expires_at, created_at FROM license WHERE app_key = 'otherapp' LIMIT 1`));
    const r = row.rows[0] as { metadata: Record<string, unknown>; expires_at: Date; created_at: Date };
    expect(r.metadata).toMatchObject({ tier: 'pro', kind: 'trial', platform: 'macos' });
    const days = Math.round((new Date(r.expires_at).getTime() - new Date(r.created_at).getTime()) / 86_400_000);
    expect(days).toBe(14);
  });

  it('trial: persisted license term for HeardRight macOS is 30 days', async () => {
    fork();
    await post(createApp(), '/v1/licenses/trial', { app: HR, email: `p-${randomUUID()}@example.com`, platform: 'macos' });
    const r = (await withStore(STORE, (tx) => tx.execute(sql`SELECT metadata, expires_at, created_at FROM license WHERE app_key = ${HR} LIMIT 1`))).rows[0] as
      { metadata: Record<string, unknown>; expires_at: Date; created_at: Date };
    expect(r.metadata).toMatchObject({ tier: 'pro', kind: 'trial', platform: 'macos' });
    expect(Math.round((new Date(r.expires_at).getTime() - new Date(r.created_at).getTime()) / 86_400_000)).toBe(30);
  });
});

// Direct engine entry points the matrix also pins (no route in this package).
describe('engine entry points', () => {
  it('activateLicenseOnDevice / findActivationByToken accept policy inputs without a route', async () => {
    const key = await seedLicense(APP);
    registerEntitlementPolicy(recorder(() => ALLOW).policy);
    const a = await withStore(STORE, (tx) => activateLicenseOnDevice(tx, { storeId: STORE, appKey: APP, licenseKey: key, deviceId: 'raw' }));
    expect(a.kind).toBe('ok');
    if (a.kind !== 'ok') return;
    const f = await withStore(STORE, (tx) => findActivationByToken(tx, { appKey: APP, activationToken: a.activationToken, path: 'update_feed' }));
    expect(f?.activationId).toBe(a.activationId);
  });
});
