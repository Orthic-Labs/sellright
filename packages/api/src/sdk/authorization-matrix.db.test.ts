/** Enrolled-only 343-route regression scope. Full 345-route B2.8 gate lives in dedicated authorization-matrix project. */
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { env, _resetEnvForTest } from '../env.js';
import { _resetPoolsForTest } from '../db/client.js';
import { createApp } from './create-app.js';
import type { EngineApp } from './types.js';
import { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { createReadCases } from './authorization-matrix.read-cases.testkit.js';
import { createMutationCases } from './authorization-matrix.mutation-cases.testkit.js';
import { createPermissionCases, assertGrantedStaffLicense } from './authorization-matrix.permission-cases.testkit.js';
import { createResourceCases } from './authorization-matrix.resource-cases.testkit.js';
import { createContentCases } from './authorization-matrix.content-cases.testkit.js';
import { createCustomerCases, createCustomerControls } from './authorization-matrix.customer-cases.testkit.js';
import { createOrderCases } from './authorization-matrix.order-cases.testkit.js';
import { createIdentityCases, runIdentityControls } from './authorization-matrix.identity-cases.testkit.js';
import { createPublicReadCases, prepareSheeridCustomerControl } from './authorization-matrix.public-read-cases.testkit.js';
import { createConfigurationCases } from './authorization-matrix.configuration-cases.testkit.js';
import { createCartCases, createCartControls } from './authorization-matrix.cart-cases.testkit.js';
import { createIntegrationCases } from './authorization-matrix.integration-cases.testkit.js';
import { createPublicAuthCases, createPublicAuthControls } from './authorization-matrix.public-auth-cases.testkit.js';
import { createLicenseCases, createLicenseCapabilityControls, createMatrixReleasePolicy } from './authorization-matrix.license-cases.testkit.js';
import { createReconciliationCases, prepareReconciliationGrantedControls } from './authorization-matrix.reconciliation-cases.testkit.js';
import { createStorefrontCases, createStorefrontControls } from './authorization-matrix.storefront-cases.testkit.js';
import { createAssetCases, createAssetControls } from './authorization-matrix.asset-cases.testkit.js';
import { createWebhookCases } from './authorization-matrix.webhook-cases.testkit.js';
import { installAuthorizationTransport, MATRIX_PROVIDER, type AuthorizationTransport } from './authorization-matrix.transport.testkit.js';
import { createProviderCases, createProviderBillingPortal } from './authorization-matrix.provider-cases.testkit.js';
import { createPaymentCases, createPaymentControls } from './authorization-matrix.payment-cases.testkit.js';
import { createFederatedTransport, createFederatedCases, runFederatedControls, resetFederatedCaches, type FederatedTransport } from './authorization-matrix.federated-cases.testkit.js';
import { createLegacyContactCases, createSheerIdWebhookCases, createSheerIdRevokeCases, assertGrantedStaffSheerIdRevoke } from './authorization-matrix.setup-cases.testkit.js';
import { installAppleAuthorization, type AppleAuthorization } from './authorization-matrix.apple-cases.testkit.js';
import { createBoundaryCases } from './authorization-matrix.boundary-cases.testkit.js';
import { assertMatrixComplete, matrixRouteKeys, runAuthorizationMatrix, type MatrixCase, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

const ownerUrl = process.env.DATABASE_URL ?? '';
const runtimeUrl = process.env.DATABASE_URL_NONOWNER ?? '';
assertTestDatabase(ownerUrl, 'authorization-matrix owner');
assertTestDatabase(runtimeUrl, 'authorization-matrix requires nonowner runtime');
const ownerTarget = new URL(ownerUrl), runtimeTarget = new URL(runtimeUrl);
if (ownerTarget.hostname !== runtimeTarget.hostname || ownerTarget.port !== runtimeTarget.port || ownerTarget.pathname !== runtimeTarget.pathname
  || ownerTarget.searchParams.get('host') !== runtimeTarget.searchParams.get('host')) throw new Error('authorization matrix fixture/runtime database mismatch');

let engine: EngineApp | undefined, owner: pg.Pool | undefined, runtimeDir: string | undefined;
let cases: MatrixCase[] = [];
let transport: AuthorizationTransport;
let federated: FederatedTransport;
let apple: AppleAuthorization;
const previousLegacyContact = process.env.LEGACY_CONTACT_COMPAT_JSON;
const previousAasaAppIds = process.env.AASA_APP_IDS;
let customerOptions: Parameters<typeof createCustomerCases>[1];
let fixture: Awaited<ReturnType<typeof createAuthorizationFixtures>>;
const providerCalls: unknown[] = [];
beforeAll(async () => {
  runtimeDir = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'sellright-authorization-matrix-'));
  for (const name of ['assets', 'downloads', 'catalog', 'state']) await mkdir(join(runtimeDir, name));
  federated = createFederatedTransport();
  transport = installAuthorizationTransport(providerCalls, { federatedFetch: federated.fetch });
  const releaseToken = randomBytes(32).toString('base64url'), cacheToken = randomBytes(32).toString('base64url');
  const releasePolicy = createMatrixReleasePolicy(releaseToken);
  // well-known.ts reads process.env directly, outside createApp's parsed env.
  process.env.AASA_APP_IDS = 'MATRIXTEAM.cc.sellright.matrix';
  engine = await createApp({ plugins: [{ name: 'authorization-matrix-release', releaseRegistration: releasePolicy }], env: {
    // Bootstrap into a disposable test database with the normal nonowner role check.
    // Only request-time NODE_ENV is changed below; this invokes real production guards.
    NODE_ENV: 'test', DATABASE_URL: runtimeUrl, DATABASE_URL_NONOWNER: runtimeUrl,
    PGAPPNAME: 'authorization-matrix', PGPOOL_MAX: '4', PGPOOL_CONNECTION_TIMEOUT_MS: '5000',
    STOREFRONT_URL: 'https://shop.matrix.invalid', ADMIN_PUBLIC_URL: 'https://admin.matrix.invalid',
    TURNSTILE_DISABLED: 'true', DOWNLOAD_URL_SECRET: 'authorization-matrix-download-signing-secret-v1',
    STOREKIT_ALLOW_SANDBOX: '1', STOREKIT_ONLINE_CHECKS: '0',
    AASA_APP_IDS: 'MATRIXTEAM.cc.sellright.matrix', ADMIN_REQUIRE_TOTP: 'all', ADMIN_TOTP_SEAL_EXISTING: '0', SELLRIGHT_MASTER_KEY: randomBytes(32).toString('hex'),
    RATE_LIMIT_BACKEND: 'memory', SMTP_ENABLED: '', SMTP_HOST: '', GATEWAY_ACCOUNTS_JSON: '[]',
    STRIPE_SECRET_KEY_TEST: MATRIX_PROVIDER.stripeSecret, STRIPE_PUBLISHABLE_KEY_TEST: MATRIX_PROVIDER.stripePublishable,
    JOBS_ENABLED: '0', JOBS_PUSH_ENABLED: '0', CATALOG_MANIFEST_JOBS_ENABLED: '0',
    ASSET_DIR: join(runtimeDir, 'assets'), DOWNLOAD_DIR: join(runtimeDir, 'downloads'), CATALOG_DIR: join(runtimeDir, 'catalog'),
    MAINTENANCE_FLAG_FILE: join(runtimeDir, 'state', 'MAINTENANCE'), CACHE_ADMIN_TOKEN: cacheToken,
  } });
  owner = new pg.Pool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 20000 });
  fixture = await createAuthorizationFixtures({ owner, app: engine.app, databaseUrl: ownerUrl,
    runtimeDir, providerCalls, releaseToken, cacheToken });
  releasePolicy.serviceCredential!.storeSlug = fixture.storeSlug;
  // Test-only semantic configuration: production's protected OpenAPI & host/auth guards remain unmodified.
  // Never boot a deployment with a test database or change production validation.
  env.NODE_ENV = 'production';
  apple = await installAppleAuthorization(fixture);
  customerOptions = { billingPortal: createProviderBillingPortal(fixture, transport) };
  const legacyContactSecret = randomBytes(32).toString('hex'), legacyIssuedBefore = Date.now() + 3600000;
  process.env.LEGACY_CONTACT_COMPAT_JSON = JSON.stringify({ [fixture.storeId]: { secret: legacyContactSecret, issuedBefore: legacyIssuedBefore } });
  cases = [...createReadCases(fixture), ...createMutationCases(fixture), ...createPermissionCases(fixture), ...createContentCases(fixture), ...createCustomerCases(fixture, customerOptions), ...createOrderCases(fixture), ...createIdentityCases(fixture), ...createPublicReadCases(fixture), ...createResourceCases(fixture), ...createBoundaryCases(fixture), ...createCartCases(fixture), ...createIntegrationCases(fixture), ...createPublicAuthCases(fixture), ...createLicenseCases(fixture), ...createConfigurationCases(fixture), ...createReconciliationCases(fixture), ...createStorefrontCases(fixture), ...createWebhookCases(fixture), ...createAssetCases(fixture), ...createProviderCases(fixture, transport), ...createPaymentCases(fixture, transport), ...createFederatedCases(fixture, federated), ...createLegacyContactCases(fixture, { legacyContactSecret, legacyIssuedBefore }), ...createSheerIdWebhookCases(fixture, transport), ...createSheerIdRevokeCases(fixture), ...apple.cases];
}, 60_000);
afterAll(async () => {
  try {
    await engine?.shutdown();
    await owner?.end();
    apple?.cleanup();
    transport?.restore();
    resetFederatedCaches();
    if (previousLegacyContact === undefined) delete process.env.LEGACY_CONTACT_COMPAT_JSON; else process.env.LEGACY_CONTACT_COMPAT_JSON = previousLegacyContact;
    vi.restoreAllMocks();
    _resetEnvForTest();
    _resetPoolsForTest();
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
  } finally {
    if (previousAasaAppIds === undefined) delete process.env.AASA_APP_IDS; else process.env.AASA_APP_IDS = previousAasaAppIds;
  }
});

describe('B2.8 enrolled-only authorization regressions — excludes fresh-install bootstrap', () => {
  it('admits genuine customer credentials on customer contracts & returns only seeded customer A', async () => {
    for (const path of ['/v1/shop/account/address-drafts', '/v1/shop/account/addresses', '/v1/shop/account/orders', '/v1/shop/account/licenses', '/v1/shop/account/export', '/v1/shop/account/loyalty']) {
      const response = await engine!.app.request(path, { headers: fixture.customerHeaders });
      expect(response.status, path).toBe(200);
      const body = await response.json() as Record<string, any>;
      if (path.endsWith('/export')) {
        expect(body.profile.id).toBe(fixture.expectedCustomerId);
        expect(body.profile.id).not.toBe(fixture.foreignCustomerId);
      } else if (path.endsWith('/loyalty')) {
        expect(body.balance).toBe(0); expect(body.currency).toBe('USD');
      } else expect(body.items).toEqual([]);
    }
  });

  it('runs 343 enrolled contracts with genuine sessions, bound agent & unchanged denied effects', async () => {
    const actual = matrixRouteKeys(engine!.app), keys = new Set(cases.map(c => c.key));
    for (const key of keys) expect(actual).toContain(key);
    // Deliberate enrolled-only projection. Dedicated authorization-matrix project alone qualifies full actual inventory.
    const normalize = (p: string) => p.split('/').map(s => s.replace(/^:([A-Za-z0-9_]+)(?:\{[^}]*\})?/, '{$1}')).join('/');
    const result = await runAuthorizationMatrix({ cases, app: {
      routes: engine!.app.routes.filter(r => keys.has(`${r.method.toUpperCase()} ${normalize(r.path)}`)),
      request: (url, init, bindings) => engine!.app.request(url, init, bindings),
    }, diagnostics: {
      snapshotFor: (principal, method, path, status) => fixture.snapshotFor(principal, method, path, status),
      async assertSafe() {
        expect(providerCalls.filter(call => (call as { kind?: string }).kind === 'forbidden'), 'no forbidden provider/network attempt').toEqual([]);
        expect(engine!.port, 'no listener').toBeNull();
        expect(engine!.executedPhases, 'no jobs').not.toContain('jobs');
        expect(env.NODE_ENV, 'production request guards remain active').toBe('production');
        const serving = (await engine!.ctx.pool.query('SELECT current_database() AS database')).rows[0]?.database;
        const seeding = (await owner!.query('SELECT current_database() AS database')).rows[0]?.database;
        expect(serving, 'serving DB remains pinned').toBe(decodeURIComponent(runtimeTarget.pathname.slice(1)));
        expect(seeding, 'fixture DB remains pinned').toBe(decodeURIComponent(ownerTarget.pathname.slice(1)));
      },
    } });
    expect(result.cellCount).toBe(cases.length * 8);
    expect(result.deniedMutationsUnchanged).toBeGreaterThan(0);
    expect(providerCalls.filter(call => (call as { kind?: string }).kind === 'forbidden')).toEqual([]);
    expect(engine!.port).toBeNull();
    expect(engine!.executedPhases).not.toContain('jobs');
  }, 900_000);

  it('admits explicit installation-admin control without granting installation data to store owners', async () => {
    const build = await engine!.app.request('/v1/admin/system/build-info', { headers: fixture.positiveControls.installationAdmin });
    expect(build.status).toBe(200);
    expect((await build.json() as any).engine.name).toBe('@sellright/api');
    const config = await engine!.app.request('/v1/admin/system/effective-config', { headers: fixture.positiveControls.installationAdmin });
    expect(config.status).toBe(200);
    const projection = await config.json() as any;
    expect(projection.schema).toBe('config/v1');
    expect(projection.store.slug).toBe(fixture.storeSlug);
    expect(projection.intended).toBeTypeOf('object');
  });

  it('admits human staff with explicit license grant & records issuance provenance', async () => {
    await assertGrantedStaffLicense({ app: engine!.app, fixture, proof: {
      equal: (actual, expected, label) => { expect(actual, label).toEqual(expected); },
      ok: (condition, label) => { expect(condition, label).toBeTruthy(); },
    } });
  });

  it('admits genuine customer ownership controls with committed effects on fresh targets', async () => {
    for (const control of createCustomerControls(fixture, customerOptions)) {
      const prepared = await control.prepare();
      const response = await fixture.request(prepared.url, prepared.init, prepared.env);
      expect(response.status, control.key).toBe(control.status);
      await prepared.verify(response, {
        equal: (actual, expected, label) => { expect(actual, control.key + ': ' + label).toEqual(expected); },
        ok: (condition, label) => { expect(condition, control.key + ': ' + label).toBeTruthy(); },
      });
    }
    expect(providerCalls.filter(call => (call as { kind?: string }).kind === 'forbidden')).toEqual([]);
  }, 120_000);

  it('admits configured SheerID customer & genuine installation controls', async () => {
    const prepared = await prepareSheeridCustomerControl(fixture);
    const response = await fixture.request(prepared.url, prepared.init, prepared.env);
    expect(response.status).toBe(200);
    await prepared.verify(response, {
      equal: (actual, expected, label) => { expect(actual, label).toEqual(expected); },
      ok: (condition, label) => { expect(condition, label).toBeTruthy(); },
    });
    await runIdentityControls(fixture);
    expect(providerCalls.filter(call => (call as { kind?: string }).kind === 'forbidden')).toEqual([]);
  }, 120_000);

  it('proves cart, mailbox & license capabilities independently of supplied admin credentials', async () => {
    const controls: { key: string; status: number; prepare(): Promise<PreparedMatrixCell> }[] = [
      ...createCartControls(fixture), ...createPublicAuthControls(fixture), ...createLicenseCapabilityControls(fixture), ...createStorefrontControls(fixture), ...createAssetControls(fixture), ...createPaymentControls(fixture, transport), ...apple.controls,
    ];
    for (const control of controls) {
      const prepared = await control.prepare();
      const before = prepared.snapshot ? structuredClone(await prepared.snapshot()) : undefined;
      const response = await fixture.request(prepared.url, prepared.init, prepared.env);
      if (prepared.snapshot) expect(await prepared.snapshot(), control.key + ': unchanged denied effects').toEqual(before);
      expect(response.status, control.key).toBe(control.status);
      await prepared.verify(response, {
        equal: (actual, expected, label) => { expect(actual, control.key + ': ' + label).toEqual(expected); },
        ok: (condition, label) => { expect(condition, control.key + ': ' + label).toBeTruthy(); },
      });
    }
    expect(providerCalls.filter(call => (call as { kind?: string }).kind === 'forbidden')).toEqual([]);
  }, 180_000);

  it('admits real staff granted refunds for reconciliation & preserves operator provenance', async () => {
    for (const prepared of await prepareReconciliationGrantedControls(fixture)) {
      const response = await fixture.request(prepared.url, prepared.init, prepared.env);
      expect(response.status, prepared.url).toBe(200);
      await prepared.verify(response, {
        equal: (actual, expected, label) => { expect(actual, label).toEqual(expected); },
        ok: (condition, label) => { expect(condition, label).toBeTruthy(); },
      });
    }
  }, 120_000);

  it('admits explicit human verification grant & validates synthetic federated trust without granting header authority', async () => {
    await assertGrantedStaffSheerIdRevoke({ app: engine!.app, fixture, proof: {
      equal: (actual, expected, label) => { expect(actual, label).toEqual(expected); },
      ok: (condition, label) => { expect(condition, label).toBeTruthy(); },
    } });
    await runFederatedControls(fixture, federated);
    expect(providerCalls.filter(call => (call as { kind?: string }).kind === 'forbidden')).toEqual([]);
  }, 180_000);

  it('declares exact enrolled-only scope; full setup qualification belongs to dedicated fresh-DB lane', () => {
    const actual = matrixRouteKeys(engine!.app), keys = new Set(cases.map(c => c.key));
    expect(cases).toHaveLength(343);
    expect(actual.filter(key => !keys.has(key))).toEqual(['GET /v1/setup/status', 'POST /v1/setup/claim']);
    const normalize = (path: string) => path.split('/').map(segment => segment.replace(/^:([A-Za-z0-9_]+)(?:\{[^}]*\})?/, '{$1}')).join('/');
    assertMatrixComplete({
      routes: engine!.app.routes.filter(route => keys.has(route.method.toUpperCase() + ' ' + normalize(route.path))),
      request: (url, init, bindings) => engine!.app.request(url, init, bindings),
    }, cases);
  });
});
