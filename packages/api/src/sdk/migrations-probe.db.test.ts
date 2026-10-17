/**
 * Startup migration gate against real Postgres (*_test): the journal probe (migration 0095) lets a runtime role with no
 * access to schema `drizzle` verify migrations; pending migrations refuse; an up-to-date database passes.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { PACKAGED_MIGRATIONS_DIR, PendingMigrationsError, assertMigrationsCurrent, readJournal, resolveTracks, trackStatus } from './migrations.js';

const DB = process.env.DATABASE_URL as string;
assertTestDatabase(DB, 'migrations-probe.db.test.ts');

// Never install or re-own the probe in the shared test database. Each role and
// the scratch database belong exclusively to this file, including partial setup.
const suffix = randomBytes(6).toString('hex');
const DATABASE = `sr_migration_probe_${suffix}_test`;
const ENGINE_ROLE = `probe_engine_${suffix}`;
const ROLE = `probe_rt_${suffix}`;
const PLUGIN_ROLE = `probe_plugin_${suffix}`;
const PLUGIN_RT_ROLE = `probe_plugin_rt_${suffix}`;
const TABLE = `__drizzle_migrations_probe_${suffix}`;
const WHEN = 1000;
const adminUrl = new URL(DB);
adminUrl.pathname = '/postgres';
const scratchUrl = new URL(DB);
scratchUrl.pathname = `/${DATABASE}`;
assertTestDatabase(scratchUrl.toString(), 'migration probe scratch database');
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const owner = new pg.Client({ connectionString: scratchUrl.toString() });
const createdRoles: string[] = [];
let databaseCreated = false;
let adminStarted = false;
let ownerStarted = false;
let scratch = '';
const engineTracks = resolveTracks([]);

/** Autocommit is intentional: a refused probe must not abort the fallback read. */
async function asRole<T>(role: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: scratchUrl.toString() });
  try {
    await c.connect();
    await c.query(`SET ROLE ${role}`);
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'sr-migration-probe-'));
  adminStarted = true;
  await admin.connect();
  for (const role of [ENGINE_ROLE, ROLE, PLUGIN_ROLE, PLUGIN_RT_ROLE]) {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
    createdRoles.push(role);
    // PG 16+: the creator's ADMIN membership alone does not permit SET ROLE.
    await admin.query(`GRANT ${role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
  }
  await admin.query(`CREATE DATABASE ${DATABASE} TEMPLATE template0`);
  databaseCreated = true;
  ownerStarted = true;
  await owner.connect();
  await owner.query(`GRANT CREATE ON DATABASE ${DATABASE} TO ${ENGINE_ROLE}`);
  await owner.query(`GRANT CREATE ON SCHEMA public TO ${ENGINE_ROLE}`);
  await owner.query(`SET ROLE ${ENGINE_ROLE}`);
  await owner.query('CREATE SCHEMA drizzle');
  await owner.query('CREATE TABLE drizzle."__drizzle_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)');
  const entries = readJournal(PACKAGED_MIGRATIONS_DIR);
  expect(entries.length).toBeGreaterThan(0);
  // The gate reads only journal timestamps; no unrelated commerce schema is needed.
  await owner.query('INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
    ['synthetic-probe-fixture', Math.max(...entries.map((entry) => entry.when))]);
  await owner.query(readFileSync(join(PACKAGED_MIGRATIONS_DIR, '0095_migration_journal_probe.sql'), 'utf8'));
  const probeOwner = await owner.query(`SELECT r.rolname, r.rolsuper, r.rolbypassrls
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.sellright_migration_last_applied(text,text)'::regprocedure`);
  expect(probeOwner.rows).toEqual([{ rolname: ENGINE_ROLE, rolsuper: false, rolbypassrls: false }]);
  await owner.query(`GRANT USAGE, CREATE ON SCHEMA drizzle TO ${PLUGIN_ROLE}`);
  await owner.query(`GRANT USAGE ON SCHEMA drizzle TO ${PLUGIN_RT_ROLE}`);
  await asRole(PLUGIN_ROLE, async (c) => {
    await c.query(`CREATE TABLE drizzle."${TABLE}" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    await c.query(`INSERT INTO drizzle."${TABLE}" (hash, created_at) VALUES ('h', $1)`, [WHEN]);
  });
  // Mandatory preconditions: neither the ordinary engine owner nor its definer
  // probe can read the plugin's journal. Setup errors must fail, never skip.
  await expect(owner.query(`SELECT 1 FROM drizzle."${TABLE}"`)).rejects.toMatchObject({ code: '42501' });
  await expect(owner.query('SELECT public.sellright_migration_last_applied($1, $2)', ['drizzle', TABLE]))
    .rejects.toMatchObject({ code: '42501' });
});

afterAll(async () => {
  const errors: unknown[] = [];
  const clean = async (fn: () => unknown | Promise<unknown>) => {
    try { await fn(); } catch (error) { errors.push(error); }
  };
  if (ownerStarted) await clean(() => owner.end());
  if (databaseCreated) await clean(() => admin.query(`DROP DATABASE ${DATABASE} WITH (FORCE)`));
  for (const role of [...createdRoles].reverse()) await clean(() => admin.query(`DROP ROLE ${role}`));
  if (adminStarted) await clean(() => admin.end());
  if (scratch) await clean(() => rmSync(scratch, { recursive: true, force: true }));
  if (errors.length) throw new AggregateError(errors, 'Migration probe fixture cleanup failed');
});

/** A journal folder = the packaged journal plus one entry newer than anything applied. */
function folderWithPendingEntry(): string {
  const dir = join(scratch, 'pending');
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const real = JSON.parse(readFileSync(join(PACKAGED_MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
  const last = real.entries[real.entries.length - 1]!;
  real.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: '9999_pending_probe_test', breakpoints: true });
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(real));
  return dir;
}

describe('migration journal probe (0095)', () => {
  it('an up-to-date database verifies (every packaged journal entry applied)', async () => {
    const statuses = await assertMigrationsCurrent(owner, engineTracks);
    expect(statuses[0]!.pending).toEqual([]);
    expect(statuses[0]!.journalEntries).toBe(readJournal(PACKAGED_MIGRATIONS_DIR).length);
  });

  it('a pending migration refuses with PendingMigrationsError naming it', async () => {
    const tracks = resolveTracks([], { folder: folderWithPendingEntry() });
    const err = await assertMigrationsCurrent(owner, tracks).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PendingMigrationsError);
    expect((err as Error).message).toMatch(/9999_pending_probe_test/);
    expect((err as PendingMigrationsError).statuses[0]!.pending).toEqual(['9999_pending_probe_test']);
  });

  it('the probe reports the same newest created_at as the journal table, and NULL for an absent table', async () => {
    const direct = await owner.query('SELECT max(created_at)::bigint AS last FROM drizzle."__drizzle_migrations"');
    const probe = await owner.query(`SELECT public.sellright_migration_last_applied('drizzle', '__drizzle_migrations') AS last`);
    expect(String(probe.rows[0].last)).toBe(String(direct.rows[0].last));
    const absent = await owner.query(`SELECT public.sellright_migration_last_applied('drizzle', 'definitely_missing_journal') AS last`);
    expect(absent.rows[0].last).toBeNull();
  });

  it('the probe refuses any schema other than drizzle (it cannot be aimed at arbitrary tables)', async () => {
    await expect(owner.query(`SELECT public.sellright_migration_last_applied('public', 'store')`)).rejects.toMatchObject({ code: '22023' });
  });

  describe('runtime role without access to schema drizzle', () => {
    it('cannot read the journal directly (the gap) but still verifies through the probe; pending still refuses', async () => {
      await asRole(ROLE, async (c) => {
        await expect(c.query('SELECT 1 FROM drizzle."__drizzle_migrations" LIMIT 1')).rejects.toMatchObject({ code: '42501' });
        const statuses = await assertMigrationsCurrent(c, engineTracks);
        expect(statuses[0]!.pending).toEqual([]);
        const status = await trackStatus(c, resolveTracks([], { folder: folderWithPendingEntry() })[0]!);
        expect(status.pending).toEqual(['9999_pending_probe_test']);
        await expect(assertMigrationsCurrent(c, resolveTracks([], { folder: folderWithPendingEntry() }))).rejects.toBeInstanceOf(PendingMigrationsError);
      });
    });
  });
});

describe('separately owned engine and plugin journals', () => {
  function pluginFolder(): string {
    const dir = join(scratch, 'plugin');
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', when: WHEN, tag: '0000_plugin_probe', breakpoints: true }] }));
    return dir;
  }
  const track = () => ({ name: 'plugin', folder: pluginFolder(), schema: 'drizzle', table: TABLE });

  async function asPluginOwner(sql: string): Promise<void> {
    await asRole(PLUGIN_ROLE, async (c) => { await c.query(sql); });
  }

  it('falls back to the caller\'s own read when the probe is refused (42501) and the caller can read the journal', async () => {
    await asPluginOwner(`GRANT SELECT ON drizzle."${TABLE}" TO ${PLUGIN_RT_ROLE}`);
    await asRole(PLUGIN_RT_ROLE, async (c) => {
      const status = await trackStatus(c, track());
      expect(status.lastApplied).toBe(WHEN);
      expect(status.pending).toEqual([]);
      // the engine track still verifies through the probe in the same session
      expect((await assertMigrationsCurrent(c, engineTracks))[0]!.pending).toEqual([]);
    });
  });

  it('still fails (42501) when the caller cannot read the journal either', async () => {
    await asPluginOwner(`REVOKE SELECT ON drizzle."${TABLE}" FROM ${PLUGIN_RT_ROLE}`);
    await asRole(PLUGIN_RT_ROLE, async (c) => {
      await expect(trackStatus(c, track())).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('a pending plugin migration is reported through the fallback read', async () => {
    await asPluginOwner(`GRANT SELECT ON drizzle."${TABLE}" TO ${PLUGIN_RT_ROLE}`);
    const dir = join(scratch, 'plugin-pending');
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [
      { idx: 0, version: '7', when: WHEN, tag: '0000_plugin_probe', breakpoints: true },
      { idx: 1, version: '7', when: WHEN + 1, tag: '0001_plugin_next', breakpoints: true },
    ] }));
    await asRole(PLUGIN_RT_ROLE, async (c) => {
      const err = await assertMigrationsCurrent(c, [{ name: 'plugin', folder: dir, schema: 'drizzle', table: TABLE }]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PendingMigrationsError);
      expect((err as PendingMigrationsError).statuses[0]!.pending).toEqual(['0001_plugin_next']);
    });
  });
});

