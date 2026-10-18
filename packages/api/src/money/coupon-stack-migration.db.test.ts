import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase } from '../db/rls-test-utils.js';

const url = process.env.DATABASE_URL ?? '';
assertTestDatabase(url, 'coupon stack migration fixture');
const pool = new Pool({ connectionString: url, max: 1 });
const tag = '0107_coupon_stack_backfill_rls';
const migration = readFileSync(new URL('../../drizzle/' + tag + '.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  version: string; dialect: string; entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};
afterAll(() => pool.end());

type OrderRow = { id: string; store_id: string; coupon_codes: string[] } & Record<string, unknown>;
type PromotionRow = { id: string; store_id: string; code: string | null } & Record<string, unknown>;

describe('coupon stack backfill migration', () => {
  it('repairs every FORCE-RLS tenant, preserves exact history & restores caller context', async () => {
    const client = await pool.connect();
    const suffix = randomUUID().replaceAll('-', '');
    const schema = 'coupon_backfill_' + suffix;
    const owner = 'coupon_backfill_owner_' + suffix;
    const stores = [randomUUID(), randomUUID()];
    const kinds = ['exact', 'spaced', 'whitespace-only', 'nonempty', 'blank', 'null-code', 'unlinked', 'wrong-store'];
    const codes: Record<string, string | null> = { exact: 'MiXeD', spaced: ' MiXeD ', 'whitespace-only': '   ',
      nonempty: 'Replacement', blank: '', 'null-code': null, unlinked: 'Unlinked', 'wrong-store': 'Wrong' };
    const promotions: PromotionRow[] = [];
    const orders: OrderRow[] = [];
    const expectedCodes = new Map<string, string[]>();
    let createdOwner = false;
    let fixtureCommitted = false;
    let databaseIdent = '';
    let folder = '';
    let priorStore: string | null = null;
    try {
      priorStore = (await client.query("SELECT current_setting('app.current_store', true) AS scope")).rows[0].scope;
      await client.query('BEGIN');
      const caller = (await client.query('SELECT rolsuper, rolbypassrls, current_database() AS database FROM pg_roles WHERE rolname = current_user')).rows[0];
      databaseIdent = '"' + String(caller.database).replaceAll('"', '""') + '"';
      // CI's superuser must become an ordinary schema owner to exercise FORCE RLS.
      if (caller.rolsuper || caller.rolbypassrls) {
        await client.query('CREATE ROLE ' + owner + ' NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT');
        createdOwner = true;
        await client.query('GRANT ' + owner + ' TO CURRENT_USER WITH INHERIT FALSE, SET TRUE');
        await client.query('GRANT CREATE ON DATABASE ' + databaseIdent + ' TO ' + owner);
        await client.query('CREATE SCHEMA ' + schema + ' AUTHORIZATION ' + owner);
        await client.query('SET LOCAL ROLE ' + owner);
      } else {
        await client.query('CREATE SCHEMA ' + schema);
      }
      await client.query('SET LOCAL search_path TO ' + schema + ', public');
      expect((await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows)
        .toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await client.query(`
        CREATE TABLE store (id uuid PRIMARY KEY);
        CREATE TABLE promotion (id uuid PRIMARY KEY, store_id uuid NOT NULL, code text, metadata jsonb);
        CREATE TABLE "order" (id uuid PRIMARY KEY, store_id uuid NOT NULL, promotion_id uuid REFERENCES promotion(id),
          coupon_codes text[] NOT NULL DEFAULT '{}', total integer NOT NULL, pricing_snapshot jsonb, metadata jsonb);
      `);
      for (const storeId of stores) {
        await client.query('INSERT INTO store VALUES ($1)', [storeId]);
        for (const kind of kinds) {
          const row = (await client.query('INSERT INTO promotion VALUES ($1,$2,$3,$4) RETURNING *',
            [randomUUID(), storeId, codes[kind], { kind, preserved: true }])).rows[0] as PromotionRow;
          promotions.push(row);
        }
      }
      for (const storeId of stores) for (const kind of kinds) {
        const promotion = promotions.find(row => row.store_id === (kind === 'wrong-store' ? stores.find(id => id !== storeId) : storeId)
          && (row.metadata as { kind: string }).kind === (kind === 'wrong-store' ? 'exact' : kind))!;
        const coupons = kind === 'nonempty' ? ['Keep ', 'KEEP', ''] : [];
        const row = (await client.query(`INSERT INTO "order" VALUES ($1,$2,$3,$4,12345,$5,$6) RETURNING *`,
          [randomUUID(), storeId, kind === 'unlinked' ? null : promotion.id, coupons,
            { version: 1, preserved: ['money', 'edit evidence'] }, { kind, preserved: true }])).rows[0] as OrderRow;
        orders.push(row);
        expectedCodes.set(row.id, ['exact', 'spaced', 'whitespace-only'].includes(kind) ? [codes[kind]!] : coupons);
      }
      for (const table of ['promotion', '"order"']) {
        await client.query('ALTER TABLE ' + table + ' ENABLE ROW LEVEL SECURITY; ALTER TABLE ' + table + ' FORCE ROW LEVEL SECURITY;'
          + ' CREATE POLICY tenant_isolation ON ' + table
          + " USING (store_id = nullif(current_setting('app.current_store', true), '')::uuid)"
          + " WITH CHECK (store_id = nullif(current_setting('app.current_store', true), '')::uuid)");
      }
      const assertTenants = async () => {
        const force = await client.query(`SELECT relrowsecurity, relforcerowsecurity, relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned
          FROM pg_class WHERE oid IN ('promotion'::regclass, '"order"'::regclass)`);
        expect(force.rows).toEqual([
          { relrowsecurity: true, relforcerowsecurity: true, owned: true },
          { relrowsecurity: true, relforcerowsecurity: true, owned: true },
        ]);
        for (const storeId of stores) {
          await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
          const actualOrders = (await client.query('SELECT * FROM "order" ORDER BY id')).rows;
          expect(actualOrders).toEqual(orders.filter(row => row.store_id === storeId)
            .map(row => ({ ...row, coupon_codes: expectedCodes.get(row.id) })).sort((a, b) => a.id.localeCompare(b.id)));
          expect((await client.query('SELECT * FROM promotion ORDER BY id')).rows)
            .toEqual(promotions.filter(row => row.store_id === storeId).sort((a, b) => a.id.localeCompare(b.id)));
          expect((await client.query('SELECT id FROM "order" WHERE store_id <> $1', [storeId])).rows).toEqual([]);
          expect((await client.query('SELECT id FROM promotion WHERE store_id <> $1', [storeId])).rows).toEqual([]);
        }
      };
      await client.query("SELECT set_config('app.current_store', '', true)");
      expect((await client.query('SELECT * FROM "order"')).rows).toEqual([]);
      expect((await client.query('SELECT * FROM promotion')).rows).toEqual([]);
      await client.query('SAVEPOINT before_backfill');
      await client.query(migration);
      expect((await client.query("SELECT current_setting('app.current_store') AS scope")).rows[0].scope).toBe('');
      expect((await client.query('SELECT * FROM "order"')).rows).toEqual([]);
      expect((await client.query('SELECT * FROM promotion')).rows).toEqual([]);
      await assertTenants();
      await client.query("SELECT set_config('app.current_store', $1, true)", [stores[0]]);
      await client.query(migration);
      expect((await client.query("SELECT current_setting('app.current_store') AS scope")).rows[0].scope).toBe(stores[0]);
      await assertTenants();
      // Restore the pre-backfill upgrade fixture before exercising the real migrator.
      await client.query('ROLLBACK TO SAVEPOINT before_backfill');
      await client.query('COMMIT');
      fixtureCommitted = true;
      if (createdOwner) await client.query('SET ROLE ' + owner);
      await client.query('SET search_path TO ' + schema + ', public');
      await client.query("SELECT set_config('app.current_store', '', false)");
      const entry = journal.entries.find(row => row.tag === tag);
      expect(entry).toBeDefined();
      folder = mkdtempSync(join(tmpdir(), 'coupon-backfill-'));
      mkdirSync(join(folder, 'meta'));
      writeFileSync(join(folder, tag + '.sql'), migration);
      writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ version: journal.version, dialect: journal.dialect, entries: [entry] }));
      const db = drizzle(client);
      const options = { migrationsFolder: folder, migrationsSchema: schema, migrationsTable: '__coupon_backfill_migrations' };
      await migrate(db, options);
      expect((await client.query("SELECT current_setting('app.current_store') AS scope")).rows[0].scope).toBe('');
      await client.query('BEGIN');
      await assertTenants();
      await client.query('COMMIT');
      const applied = (await client.query('SELECT hash, created_at FROM ' + schema + '.__coupon_backfill_migrations')).rows;
      expect(applied).toHaveLength(1);
      expect(Number(applied[0].created_at)).toBe(entry!.when);
      await client.query("SELECT set_config('app.current_store', $1, false)", [stores[0]]);
      await migrate(db, options);
      expect((await client.query("SELECT current_setting('app.current_store') AS scope")).rows[0].scope).toBe(stores[0]);
      expect((await client.query('SELECT hash, created_at FROM ' + schema + '.__coupon_backfill_migrations')).rows).toEqual(applied);
      await client.query('BEGIN');
      await assertTenants();
      await client.query('COMMIT');
    } finally {
      const errors: unknown[] = [];
      const clean = async (fn: () => unknown | Promise<unknown>) => {
        try { await fn(); } catch (error) { errors.push(error); }
      };
      await clean(() => client.query('ROLLBACK'));
      await clean(() => client.query('RESET ROLE'));
      await clean(() => client.query('RESET search_path'));
      await clean(() => client.query("SELECT set_config('app.current_store', $1, false)", [priorStore ?? '']));
      await clean(() => client.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'));
      if (createdOwner) {
        if (fixtureCommitted) await clean(() => client.query('REVOKE CREATE ON DATABASE ' + databaseIdent + ' FROM ' + owner));
        await clean(() => client.query('DROP ROLE IF EXISTS ' + owner));
      }
      client.release(errors.length > 0);
      if (folder) await clean(() => rmSync(folder, { recursive: true, force: true }));
      if (errors.length) throw new AggregateError(errors, 'Coupon backfill fixture cleanup failed');
    }
  });
});
