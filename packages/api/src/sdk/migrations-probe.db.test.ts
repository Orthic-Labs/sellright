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

const owner = new pg.Client({ connectionString: DB });
const ROLE = `probe_rt_${randomBytes(4).toString('hex')}`;
let roleCreated = false;
let scratch = '';
const engineTracks = resolveTracks([]);

beforeAll(async () => {
  await owner.connect();
  scratch = mkdtempSync(join(tmpdir(), 'sr-migration-probe-'));
  try {
    await owner.query(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    // PostgreSQL 16+: a non-superuser creator gets ADMIN on the new role but not SET; grant it so SET ROLE works.
    await owner.query(`GRANT ${ROLE} TO CURRENT_USER WITH SET TRUE`).catch(() => undefined);
    roleCreated = true;
  } catch { /* the configured role cannot create roles: the least-privilege case is skipped below */ }
});

afterAll(async () => {
  if (roleCreated) await owner.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
  await owner.end().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
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
    async function asRuntimeRole<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
      const c = new pg.Client({ connectionString: DB });
      await c.connect();
      try {
        await c.query(`SET ROLE ${ROLE}`);
        return await fn(c);
      } finally { await c.end().catch(() => undefined); }
    }

    it('cannot read the journal directly (the gap) but still verifies through the probe; pending still refuses', async (ctx) => {
      if (!roleCreated) return ctx.skip();
      await asRuntimeRole(async (c) => {
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
  const OWNER_ROLE = `probe_po_${randomBytes(4).toString('hex')}`;
  const RT_ROLE = `probe_rt2_${randomBytes(4).toString('hex')}`;
  const TABLE = `__drizzle_migrations_probe_${randomBytes(4).toString('hex')}`;
  const WHEN = 1000;
  let ready = false;
  const cleanup: string[] = [];

  function pluginFolder(): string {
    const dir = join(scratch, 'plugin');
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', when: WHEN, tag: '0000_plugin_probe', breakpoints: true }] }));
    return dir;
  }
  const track = () => ({ name: 'plugin', folder: pluginFolder(), schema: 'drizzle', table: TABLE });

  beforeAll(async () => {
    try {
      // The probe's owner must be a role that is NOT allowed to read the plugin-owned journal, so the owner can be neither a
      // superuser nor a member of the plugin owner that inherits its privileges.
      const me = await owner.query(`SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname = 'sellright_migration_last_applied' AND pronamespace = 'public'::regnamespace)`);
      if (!me.rows[0] || me.rows[0].rolsuper) return;
      await owner.query(`CREATE ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`); cleanup.push(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
      await owner.query(`CREATE ROLE ${RT_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`); cleanup.unshift(`DROP ROLE IF EXISTS ${RT_ROLE}`);
      // set-only membership: the test credential can SET ROLE to the plugin owner / runtime role but inherits nothing from them
      await owner.query(`GRANT ${OWNER_ROLE} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
      await owner.query(`GRANT ${RT_ROLE} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
      await owner.query(`GRANT USAGE, CREATE ON SCHEMA drizzle TO ${OWNER_ROLE}`);
      await owner.query(`GRANT USAGE ON SCHEMA drizzle TO ${RT_ROLE}`);
      await owner.query(`SET ROLE ${OWNER_ROLE}`);
      try {
        await owner.query(`CREATE TABLE drizzle."${TABLE}" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
        await owner.query(`INSERT INTO drizzle."${TABLE}" (hash, created_at) VALUES ('h', ${WHEN})`);
      } finally { await owner.query('RESET ROLE'); }
      // precondition: the probe (engine owner's privileges) really cannot read the plugin journal
      await owner.query('SELECT public.sellright_migration_last_applied($1, $2)', ['drizzle', TABLE]).then(
        () => { throw new Error('probe could read the plugin journal; case not reproducible with this credential'); },
        (e: { code?: string }) => { if (e.code !== '42501') throw e; },
      );
      ready = true;
    } catch { /* credential cannot create/own roles, or PG < 16 membership syntax: skipped below */ }
  });

  afterAll(async () => {
    await owner.query('RESET ROLE').catch(() => undefined);
    await asPluginOwner(`DROP TABLE IF EXISTS drizzle."${TABLE}"`).catch(() => undefined);
    await owner.query(`REVOKE USAGE ON SCHEMA drizzle FROM ${RT_ROLE}`).catch(() => undefined);
    await owner.query(`REVOKE USAGE, CREATE ON SCHEMA drizzle FROM ${OWNER_ROLE}`).catch(() => undefined);
    for (const q of cleanup) await owner.query(q).catch(() => undefined);
  });

  async function asPluginOwner(sql: string): Promise<void> {
    await owner.query(`SET ROLE ${OWNER_ROLE}`);
    try { await owner.query(sql); } finally { await owner.query('RESET ROLE'); }
  }
  async function asRuntime<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: DB });
    await c.connect();
    try { await c.query(`SET ROLE ${RT_ROLE}`); return await fn(c); } finally { await c.end().catch(() => undefined); }
  }

  it('falls back to the caller\'s own read when the probe is refused (42501) and the caller can read the journal', async (ctx) => {
    if (!ready) return ctx.skip();
    await asPluginOwner(`GRANT SELECT ON drizzle."${TABLE}" TO ${RT_ROLE}`);
    await asRuntime(async (c) => {
      const status = await trackStatus(c, track());
      expect(status.lastApplied).toBe(WHEN);
      expect(status.pending).toEqual([]);
      // the engine track still verifies through the probe in the same session
      expect((await assertMigrationsCurrent(c, engineTracks))[0]!.pending).toEqual([]);
    });
  });

  it('still fails (42501) when the caller cannot read the journal either', async (ctx) => {
    if (!ready) return ctx.skip();
    await asPluginOwner(`REVOKE SELECT ON drizzle."${TABLE}" FROM ${RT_ROLE}`);
    await asRuntime(async (c) => {
      await expect(trackStatus(c, track())).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('a pending plugin migration is reported through the fallback read', async (ctx) => {
    if (!ready) return ctx.skip();
    await asPluginOwner(`GRANT SELECT ON drizzle."${TABLE}" TO ${RT_ROLE}`);
    const dir = join(scratch, 'plugin-pending');
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [
      { idx: 0, version: '7', when: WHEN, tag: '0000_plugin_probe', breakpoints: true },
      { idx: 1, version: '7', when: WHEN + 1, tag: '0001_plugin_next', breakpoints: true },
    ] }));
    await asRuntime(async (c) => {
      const err = await assertMigrationsCurrent(c, [{ name: 'plugin', folder: dir, schema: 'drizzle', table: TABLE }]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PendingMigrationsError);
      expect((err as PendingMigrationsError).statuses[0]!.pending).toEqual(['0001_plugin_next']);
    });
  });
});

