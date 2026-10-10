/**
 * Phase 2 acceptance gate (plan 2.2/2.3/2.6): the sample plugin consumes the PACKED
 * `@sellright/api` tarball in a clean temp install and boots createApp against the
 * defork_sdk_test database. Needs DATABASE_URL pointing at a *_test database (migrated
 * through the engine track by the test itself) and network access for transitive installs.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const DB = process.env.DATABASE_URL ?? '';
const STORE_SLUG = 'packed-sample-store';
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

let tmp = '';
let result: Record<string, any> = {};

beforeAll(async () => {
  if (!/_test(\?|$)/.test(DB)) throw new Error('DATABASE_URL must point at a *_test database');
  tmp = mkdtempSync(join(tmpdir(), 'sr-packed-'));
  const packs = join(tmp, 'packs');
  mkdirSync(packs);
  // 1. build + pack both artifacts (same commands a release uses)
  run('pnpm', ['--filter', '@sellright/api', 'build'], repo);
  run('pnpm', ['--filter', '@sellright/api', 'pack', '--pack-destination', packs], repo);
  run('pnpm', ['--filter', '@sellright/sample-plugin', 'build'], repo);
  run('pnpm', ['--filter', '@sellright/sample-plugin', 'pack', '--pack-destination', packs], repo);
  // 2. clean consumer install from the tarballs, pinned by the committed lockfile fixture.
  // The consumer's tarballs live at fixed relative paths so the lockfile specifiers are stable;
  // their integrity hashes change with every build, so the fixture is regenerated with
  // SDK_REGEN_CONSUMER_LOCK=1 (see test/fixtures/README.md) and frozen otherwise.
  const consumer = join(tmp, 'consumer');
  mkdirSync(join(consumer, 'packs'), { recursive: true });
  copyFileSync(join(packs, 'sellright-api-0.1.0.tgz'), join(consumer, 'packs', 'sellright-api-0.1.0.tgz'));
  copyFileSync(join(packs, 'sellright-sample-plugin-0.1.0.tgz'), join(consumer, 'packs', 'sellright-sample-plugin-0.1.0.tgz'));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'consumer', private: true, type: 'module',
    dependencies: {
      '@sellright/api': 'file:./packs/sellright-api-0.1.0.tgz',
      '@sellright/sample-plugin': 'file:./packs/sellright-sample-plugin-0.1.0.tgz',
      'drizzle-orm': '0.45.2', pg: '8.23.0', '@hono/zod-openapi': '1.6.3', zod: '4.6.5',
    },
  }, null, 2));
  const fixtureLock = join(here, 'fixtures', 'consumer.pnpm-lock.yaml');
  const regen = process.env.SDK_REGEN_CONSUMER_LOCK === '1';
  if (!regen && !existsSync(fixtureLock)) throw new Error(`missing ${fixtureLock}; run with SDK_REGEN_CONSUMER_LOCK=1`);
  if (!regen) copyFileSync(fixtureLock, join(consumer, 'pnpm-lock.yaml'));
  run('pnpm', ['install', regen ? '--no-frozen-lockfile' : '--frozen-lockfile'], consumer);
  if (regen) copyFileSync(join(consumer, 'pnpm-lock.yaml'), fixtureLock);
  copyFileSync(join(here, 'boot.mjs'), join(consumer, 'boot.mjs'));

  // 3. seed a store through the owner credential (the sample route resolves it by x-store-slug)
  const owner = new pg.Client({ connectionString: DB });
  await owner.connect();
  await owner.query('TRUNCATE store CASCADE');
  await owner.query(`INSERT INTO store (slug, name, currency, config) VALUES ($1, 'Packed', 'USD', '{}'::jsonb)`, [STORE_SLUG]);
  await owner.end();

  const priv = new URL(DB); priv.username = 'sellright_backup'; priv.password = '';
  const out = run('node', ['boot.mjs'], consumer, {
    ...process.env, DATABASE_URL: DB, PRIV_DATABASE_URL: priv.toString(), STORE_SLUG, NODE_ENV: 'test',
  });
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`consumer boot printed no RESULT:\n${out}`);
  result = JSON.parse(line.slice('RESULT '.length));
});

afterAll(async () => {
  if (DB) {
    const owner = new pg.Client({ connectionString: DB });
    await owner.connect();
    await owner.query('TRUNCATE store CASCADE');
    await owner.query('DROP TABLE IF EXISTS sample_note');
    await owner.query('DROP TABLE IF EXISTS drizzle.__drizzle_migrations_sample');
    await owner.end();
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('packed @sellright/api consumed by the sample plugin', () => {
  it('ships dist, drizzle, exports contract and BUILD-INFO.json (and no compiled tests)', () => {
    expect(result.artifact).toMatchObject({ hasDrizzle: true, hasContract: true, hasDist: true, testsShipped: false });
    expect(result.artifact.buildInfo.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('resolves a single instance of @sellright/api, drizzle-orm, pg (and @hono/zod-openapi)', () => {
    expect(result.instances).toEqual({ 'drizzle-orm': 1, pg: 1, '@hono/zod-openapi': 1, '@sellright/api': 1 });
  });

  it('rejects deep imports with ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    expect(Object.values(result.deep)).toEqual(Array(4).fill('ERR_PACKAGE_PATH_NOT_EXPORTED'));
  });

  it('migrate step applies the engine track then the plugin track', () => {
    expect(result.migrated.map((m: { track: string }) => m.track)).toEqual(['engine', 'sample']);
    expect(result.migrated[1].table).toBe('drizzle.__drizzle_migrations_sample');
  });

  it('refuses a privileged runtime role', () => {
    expect(result.privileged.skipped).toBe(false);
    expect(result.privileged.result).toBe('REJECTED');
  });

  it('resolves every policy registrar export from the packed subpaths', () => {
    expect(result.policyRegistrars).toEqual({
      registerStoreKitPolicy: 'function',
      registerLockPlanContributor: 'function',
      issueStoreKitActivation: 'function',
      storeKitLicenseKey: 'function',
      sellrightRespond: 'function',
      sourceFromTransaction: 'function',
      registerEntitlementPolicy: 'function',
      registerPaymentPolicy: 'function',
      resolveRuntimeArtifactPromotion: 'function',
      revokeLicenseInTx: 'function',
      restoreLicenseInTx: 'function',
      createLicenseRevocationFeed: 'function',
    });
  });

  it('boots the composed app: phases, plugin routes, preRoute, env extension, plugin table, health', () => {
    expect(result.phases).toEqual(['configure', 'preRoute', 'routes', 'schema', 'migrations', 'services']);
    expect(result.ping).toEqual({ status: 200, body: { ok: true, greeting: 'packed', store: STORE_SLUG, engineTables: expect.any(Number) }, pre: '1' });
    expect(result.plain).toEqual({ bearer: 'tok-1' });
    expect(result.on.status).toBe(409);
    expect(result.table).toBe('sample_note');
    expect(result.health).toBe(200);
  });

  it('route inventory lists the plugin .get()/.on() routes as undocumented and has no orphaned OpenAPI operations', () => {
    expect(result.inventory.plugin).toEqual(['GET /v1/sample/legacy', 'GET /v1/sample/ping', 'GET /v1/sample/plain', 'PUT /v1/sample/on']);
    expect(result.inventory.undocumentedPlugin).toEqual(['GET /v1/sample/plain', 'PUT /v1/sample/on']);
    expect(result.inventory.orphaned).toBe(0);
  });

  it('composed OpenAPI documents the legacy 409 with a real example equal to the live body (plan 2.5)', () => {
    expect(result.legacy.flagged).toBe(true);
    expect(result.legacy.violations).toEqual([]);
    expect(result.legacy.example).toEqual({ error: 'sample conflict', code: 'sample_conflict' });
    // the engine keeps requestId as a top-level sibling (not part of the documented example)
    expect(result.legacy.live).toEqual({ status: 409, body: result.legacy.example, hasRequestId: true });
  });

  it('serves the plugin AASA overlay merged with the base webcredentials app (plan 2.6)', () => {
    expect(result.aasa.status).toBe(200);
    expect(result.aasa.body.webcredentials).toEqual({ apps: ['BASEID1234.com.example.base'] });
    expect(result.aasa.body.applinks.details).toEqual([{ appID: 'SAMPL3PLUG.com.example.sample', paths: ['/sample/*'] }]);
  });

  it('shuts down in the fixed order and runs plugin hooks', () => {
    expect(result.shutdown.steps).toEqual(['stop-admitting', 'cancel-jobs', 'drain-http', 'plugin-shutdown', 'close-resources', 'close-pool']);
    expect(result.shutdown.phase).toBe('closed');
    expect(result.shutdown.state).toMatchObject({ greeting: 'packed', servicesRan: true, shutdownRan: true });
  });
});
