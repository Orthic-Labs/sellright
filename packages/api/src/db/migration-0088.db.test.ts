/**
 * 0088 upgrade path: the webhook_delivery.updated_at backfill must actually
 * touch rows of EVERY store (the table is FORCE RLS and the migration runs
 * without app.current_store). Migrates a scratch *_test database to 0087-state
 * (everything before 0088), seeds processing rows for two stores, applies 0088,
 * and asserts the backfill. Needs CREATE DATABASE rights on the same server.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const DB = process.env.DATABASE_URL ?? '';
if (!/_test(\b|$|\?)/.test(DB)) throw new Error('migration-0088 test needs a *_test DATABASE_URL');
const url = new URL(DB);
const scratch = 'defork_mig0088_test';
const scratchUrl = (() => { const u = new URL(DB); u.pathname = `/${scratch}`; return u.toString(); })();
const adminUrl = (() => { const u = new URL(DB); u.pathname = '/postgres'; return u.toString(); })();
const API = join(import.meta.dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'mig0088-'));

const migrate = (dir: string) => execFileSync('npx', ['tsx', 'src/scripts/migrate.ts'], {
  cwd: API, stdio: 'pipe', env: { ...process.env, DATABASE_URL: scratchUrl, MIGRATIONS_DIR: dir },
});

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${scratch}`);
  await c.end();
});

describe('migration 0088 backfill', () => {
  it('backfills processing webhook rows for every store despite FORCE RLS, and restores FORCE', async () => {
    void url;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await admin.query(`CREATE DATABASE ${scratch}`);
    await admin.end();

    // Everything BEFORE 0088.
    const pre = join(tmp, 'pre');
    cpSync(join(API, 'drizzle'), pre, { recursive: true });
    rmSync(join(pre, '0088_defork_instrumentation.sql'));
    const jp = join(pre, 'meta', '_journal.json');
    const j = JSON.parse(readFileSync(jp, 'utf8')) as { entries: Array<{ tag: string; when: number }> };
    // Pre-0088 state = every migration ordered before 0088 (later ones may depend on its columns).
    const cut = j.entries.find((e) => e.tag === '0088_defork_instrumentation')!.when;
    j.entries = j.entries.filter((e) => e.when < cut);
    writeFileSync(jp, JSON.stringify(j));
    migrate(pre);

    const ids = { a: 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0', b: 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b0b0' };
    const c = new pg.Client({ connectionString: scratchUrl });
    await c.connect();
    const rows: Record<string, string> = {};
    for (const [k, store] of Object.entries(ids)) {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_store', $1, true)`, [store]);
      await c.query(`INSERT INTO store (id, slug, name) VALUES ($1, $2, $2)`, [store, `mig-${k}`]);
      const ep = await c.query(`INSERT INTO webhook_endpoint (store_id, url, topics, secret) VALUES ($1, 'https://e.example/h', ARRAY['*'], 's') RETURNING id`, [store]);
      const d = await c.query(
        `INSERT INTO webhook_delivery (store_id, endpoint_id, topic, payload, status, created_at) VALUES ($1, $2, 't', '{}'::jsonb, 'processing', now() - interval '3 days') RETURNING id`,
        [store, ep.rows[0].id]);
      rows[k] = d.rows[0].id;
      await c.query('COMMIT');
    }
    await c.end();

    migrate(join(API, 'drizzle'));

    const v = new pg.Client({ connectionString: scratchUrl });
    await v.connect();
    for (const [k, store] of Object.entries(ids)) {
      await v.query('BEGIN');
      await v.query(`SELECT set_config('app.current_store', $1, true)`, [store]);
      const r = await v.query(`SELECT (updated_at = created_at) AS backfilled, claimed_at FROM webhook_delivery WHERE id = $1`, [rows[k]]);
      expect(r.rows[0], `store ${k}`).toEqual({ backfilled: true, claimed_at: null });
      await v.query('COMMIT');
    }
    const f = await v.query(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'webhook_delivery'`);
    expect(f.rows[0].f).toBe(true);
    await v.end();
  }, 180_000);
});
