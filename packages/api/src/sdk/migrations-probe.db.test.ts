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
