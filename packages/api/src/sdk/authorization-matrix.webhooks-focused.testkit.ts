/**
 * Focused signed webhook preflight only: three existing contracts × eight genuine principals (24 cells).
 * Requires same fresh dedicated *_test DB, genuine bootstrap/MFA, adapters & isolation as full gate.
 * Full actual inventory/contract completeness is asserted before any focused route projection.
 * Root provisions DB & grants first, then runs from packages/api with explicit expected DB/URLs:
 * pnpm exec vitest run --config $HOME/sites/.work/rightsites-owner-recovery-20261018/security-final-source-validation/webhooks-focused.config.mjs
 * Fresh installation is consumed. This result is not the full 345-route/2760-cell gate.
 * No DROP/TRUNCATE/reset, production export, listener, job scheduler, or external provider call.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { env, _resetEnvForTest } from '../env.js';
import { _resetPoolsForTest } from '../db/client.js';
import { createApp } from './create-app.js';
import type { EngineApp } from './types.js';
import { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { createAuthorizationBootstrapSnapshot } from './authorization-matrix.bootstrap-snapshot.testkit.js';
import { runSetupBootstrap } from './authorization-matrix.setup-cases.testkit.js';
import { createMatrixReleasePolicy } from './authorization-matrix.license-cases.testkit.js';
import { installAuthorizationTransport, MATRIX_PROVIDER, type AuthorizationTransport } from './authorization-matrix.transport.testkit.js';
import { createFederatedTransport, resetFederatedCaches } from './authorization-matrix.federated-cases.testkit.js';
import { installAppleAuthorization, type AppleAuthorization } from './authorization-matrix.apple-cases.testkit.js';
import { createQualifiedAuthorizationCases, createCoreCapabilityControls, runCoreSupplementaryControls } from './authorization-matrix.corpus.testkit.js';
import { assertMatrixComplete, matrixRouteKeys, runAuthorizationMatrix, type MatrixApp, type MatrixProof } from './authorization-matrix.testkit.js';

const focusedKeys = [
  'POST /v1/webhooks/nmi/{storeId}/{accountId}',
  'POST /v1/webhooks/sezzle/{storeId}/{accountId}',
  'POST /v1/webhooks/stripe',
] as const;
const focusedKeySet = new Set<string>(focusedKeys);

const expectedDatabase = process.env.AUTHORIZATION_MATRIX_EXPECTED_DATABASE ?? '';
if (!/^[a-z][a-z0-9_]*_test$/.test(expectedDatabase) || expectedDatabase === 'sellright_test')
  throw new Error('focused webhook authorization gate requires explicit dedicated AUTHORIZATION_MATRIX_EXPECTED_DATABASE ending _test, distinct from shared sellright_test');
const ownerUrl = process.env.DATABASE_URL ?? '', runtimeUrl = process.env.DATABASE_URL_NONOWNER ?? '';
assertTestDatabase(ownerUrl, 'focused webhook authorization gate fixture owner');
assertTestDatabase(runtimeUrl, 'focused webhook authorization gate serving role');
const ownerTarget = new URL(ownerUrl), runtimeTarget = new URL(runtimeUrl);
const nativeQualificationSocket = `${process.env.HOME ?? ''}/sites/.work/sellright-native-mainaf3-dd-staging-rehearsal-20261019-v1/socket`;
for (const target of [ownerTarget, runtimeTarget]) {
  // Isolated CI keeps its loopback TCP URLs. Native qualification admits exactly
  // this root-owned socket on PG55433; no other pg query setting may override target.
  const query = [...target.searchParams.entries()];
  const nativeSocket = target.port === '55433' && query.length === 1
    && query[0]![0] === 'host' && query[0]![1] === nativeQualificationSocket;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || (target.search && !nativeSocket)
    || decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase)
    throw new Error('focused webhook authorization gate requires exact dedicated loopback DB URL with only the authorized native socket override');
}
if (ownerTarget.hostname !== runtimeTarget.hostname || ownerTarget.port !== runtimeTarget.port
  || ownerTarget.searchParams.get('host') !== runtimeTarget.searchParams.get('host') || ownerTarget.username === runtimeTarget.username)
  throw new Error('focused webhook authorization gate requires distinct fixture/serving roles on identical dedicated DB transport & target');

let engine: EngineApp | undefined, owner: pg.Pool | undefined, runtimeDir: string | undefined;
let transport: AuthorizationTransport | undefined, apple: AppleAuthorization | undefined;
const providerCalls: unknown[] = [];
const previousLegacyContact = process.env.LEGACY_CONTACT_COMPAT_JSON;
const previousAasaAppIds = process.env.AASA_APP_IDS;
const proof: MatrixProof = {
  equal(actual, expected, label) { expect(actual, label).toEqual(expected); },
  ok(condition, label) { expect(condition, label).toBeTruthy(); },
};
afterAll(async () => {
  try { await engine?.shutdown(); }
  finally {
    if (previousAasaAppIds === undefined) delete process.env.AASA_APP_IDS;
    else process.env.AASA_APP_IDS = previousAasaAppIds;
    try { await owner?.end(); }
    finally {
      apple?.cleanup(); transport?.restore(); resetFederatedCaches();
      if (previousLegacyContact === undefined) delete process.env.LEGACY_CONTACT_COMPAT_JSON;
      else process.env.LEGACY_CONTACT_COMPAT_JSON = previousLegacyContact;
      _resetEnvForTest(); _resetPoolsForTest();
      if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
    }
  }
}, 30_000);

describe('Focused signed webhook authorization preflight — 3 contracts / 24 cells, dedicated fresh DB', () => {
  it('qualifies genuine bootstrap & full 345-route inventory before three signed webhook contracts × eight real principals (24 cells)', async () => {
    owner = new pg.Pool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 20000 });
    const ownerQuery = (sql: string, values: unknown[] = []) => owner!.query(sql, values);
    const identity = (await ownerQuery('SELECT current_database() AS database,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(identity?.database, 'explicit fixture DB identity').toBe(expectedDatabase);
    expect(identity?.rolsuper || identity?.rolbypassrls, 'complete bootstrap journal requires fixture-owner RLS visibility').toBe(true);
    expect((await ownerQuery('SELECT id FROM admin_user')).rows, 'fresh install only; never clear shared administrators').toEqual([]);
    expect((await ownerQuery('SELECT admin_user_id,store_id FROM admin_user_store')).rows, 'fresh install has no ownership fixture').toEqual([]);

    runtimeDir = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'sellright-authorization-qualified-'));
    for (const name of ['assets', 'downloads', 'catalog', 'state']) await mkdir(join(runtimeDir, name));
    const federated = createFederatedTransport();
    transport = installAuthorizationTransport(providerCalls, { federatedFetch: federated.fetch });
    const releaseToken = randomBytes(32).toString('base64url'), cacheToken = randomBytes(32).toString('base64url');
    const releasePolicy = createMatrixReleasePolicy(releaseToken);
    // well-known.ts reads process.env directly, outside createApp's parsed env.
    process.env.AASA_APP_IDS = 'MATRIXTEAM.cc.sellright.matrix';
    engine = await createApp({ plugins: [{ name: 'authorization-matrix-release', releaseRegistration: releasePolicy }], env: {
      // Normal role/migration checks run at boot. Real production request guards run below.
      NODE_ENV: 'test', DATABASE_URL: runtimeUrl, DATABASE_URL_NONOWNER: runtimeUrl,
      PGAPPNAME: 'authorization-matrix-qualified', PGPOOL_MAX: '4', PGPOOL_CONNECTION_TIMEOUT_MS: '5000',
      ADMIN_EMAIL: '', ADMIN_PASSWORD: '',
      STOREFRONT_URL: 'https://shop.matrix.invalid', ADMIN_PUBLIC_URL: 'https://admin.matrix.invalid',
      TURNSTILE_DISABLED: 'true', DOWNLOAD_URL_SECRET: 'authorization-matrix-download-signing-secret-v1',
      STOREKIT_ALLOW_SANDBOX: '1', STOREKIT_ONLINE_CHECKS: '0', AASA_APP_IDS: 'MATRIXTEAM.cc.sellright.matrix',
      ADMIN_REQUIRE_TOTP: 'all', ADMIN_TOTP_SEAL_EXISTING: '0', SELLRIGHT_MASTER_KEY: randomBytes(32).toString('hex'),
      RATE_LIMIT_BACKEND: 'memory', SMTP_ENABLED: '', SMTP_HOST: '', GATEWAY_ACCOUNTS_JSON: '[]',
      STRIPE_SECRET_KEY_TEST: MATRIX_PROVIDER.stripeSecret, STRIPE_PUBLISHABLE_KEY_TEST: MATRIX_PROVIDER.stripePublishable,
      JOBS_ENABLED: '0', JOBS_PUSH_ENABLED: '0', CATALOG_MANIFEST_JOBS_ENABLED: '0',
      ASSET_DIR: join(runtimeDir, 'assets'), DOWNLOAD_DIR: join(runtimeDir, 'downloads'), CATALOG_DIR: join(runtimeDir, 'catalog'),
      MAINTENANCE_FLAG_FILE: join(runtimeDir, 'state', 'MAINTENANCE'), CACHE_ADMIN_TOKEN: cacheToken,
    } });
    env.NODE_ENV = 'production';
    const runtimeIdentity = await engine.ctx.pool.query('SELECT current_database() AS database');
    expect(runtimeIdentity.rows[0]?.database, 'real serving pool selects exact dedicated DB').toBe(expectedDatabase);
    const receipt = await runSetupBootstrap({ app: engine.app, expectedDatabase, ownerQuery, proof,
      snapshot: createAuthorizationBootstrapSnapshot({ ownerQuery, runtimeDir, providerCalls }) });
    const fixture = await createAuthorizationFixtures({ owner, app: engine.app, databaseUrl: ownerUrl,
      runtimeDir, providerCalls, releaseToken, cacheToken, installationAdminId: receipt.adminId });
    releasePolicy.serviceCredential!.storeSlug = fixture.storeSlug;
    apple = await installAppleAuthorization(fixture);
    expect(apple.trust).toBe('synthetic-test-root-only; real ES256/x5c; online OCSP disabled');
    const legacyContact = { legacyContactSecret: randomBytes(32).toString('hex'), legacyIssuedBefore: Date.now() + 3600000 };
    process.env.LEGACY_CONTACT_COMPAT_JSON = JSON.stringify({ [fixture.storeId]: { secret: legacyContact.legacyContactSecret, issuedBefore: legacyContact.legacyIssuedBefore } });
    const adapters = { transport, federated, apple, legacyContact };
    const cases = createQualifiedAuthorizationCases(fixture, adapters, receipt);
    // Require unchanged complete actual inventory before selecting this explicitly narrow preflight.
    assertMatrixComplete(engine.app, cases);
    expect(matrixRouteKeys(engine.app)).toHaveLength(345);
    const focusedCases = cases.filter(contract => focusedKeySet.has(contract.key));
    expect(focusedCases.map(contract => contract.key).sort(), 'exact existing three contracts').toEqual([...focusedKeys].sort());
    const actualApp = engine.app;
    const request = actualApp.request.bind(actualApp);
    const focusedApp: MatrixApp = {
      routes: actualApp.routes.filter(route => matrixRouteKeys({ routes: [route], request }).some(key => focusedKeySet.has(key))),
      // Only inventory is projected; every request still reaches the same real application.
      request,
    };
    expect(matrixRouteKeys(focusedApp), 'exact actual registered three-route projection').toEqual([...focusedKeys].sort());
    const result = await runAuthorizationMatrix({ app: focusedApp, cases: focusedCases, diagnostics: {
      snapshotFor: (principal, method, path, status) => fixture.snapshotFor(principal, method, path, status),
      async assertSafe() {
        expect(providerCalls.filter(call => (call as { kind?: string }).kind === 'forbidden'), 'no forbidden provider/network attempt').toEqual([]);
        expect(engine!.port, 'no listener').toBeNull();
        expect(engine!.executedPhases, 'no jobs').not.toContain('jobs');
        expect(env.NODE_ENV, 'production request guards remain active').toBe('production');
        expect((await engine!.ctx.pool.query('SELECT current_database() AS database')).rows[0]?.database, 'serving DB remains pinned').toBe(expectedDatabase);
        expect((await ownerQuery('SELECT current_database() AS database')).rows[0]?.database, 'fixture DB remains pinned').toBe(expectedDatabase);
      },
    } });
    // Three genuine same-payload signature controls & their replays run separately from these 24 denial cells.
    expect(result.routeCount).toBe(3); expect(result.cellCount).toBe(24);
    expect(result.allowed).toBe(0); expect(result.denied).toBe(24);
    // Existing harness proves complete denial journals & committed positive effects; fatal isolation failures stop immediately.
    assertMatrixComplete(engine.app, cases);
    expect(matrixRouteKeys(engine.app)).toHaveLength(345);

    for (const control of createCoreCapabilityControls(fixture, adapters)) {
      const prepared = await control.prepare();
      const before = prepared.snapshot ? structuredClone(await prepared.snapshot()) : undefined;
      const response = await engine.app.request(prepared.url, prepared.init, prepared.env);
      if (prepared.snapshot) expect(await prepared.snapshot(), control.key + ': unchanged denied effects').toEqual(before);
      expect(response.status, control.key).toBe(control.status);
      await prepared.verify(response, proof);
    }
    await runCoreSupplementaryControls({ app: engine.app, fixture, adapters, proof });
    expect(providerCalls.filter(call => (call as { kind?: string }).kind === 'forbidden')).toEqual([]);
    expect(engine.port).toBeNull(); expect(engine.executedPhases).not.toContain('jobs');
    expect((await ownerQuery('SELECT current_database() AS database')).rows[0]?.database).toBe(expectedDatabase);
  }, 180_000);
});
