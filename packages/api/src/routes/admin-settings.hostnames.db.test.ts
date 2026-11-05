/**
 * DB tests — store hostnames are validated as FQDNs and unique across stores (security audit 2026-11-02).
 * Runs against a *_test database ONLY (wipes data).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminSettings } from './admin-settings.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-settings.hostnames.db.test.ts');

const STORE_A = 'ffffffff-0000-0000-0000-0000000008a1';
const STORE_B = 'ffffffff-0000-0000-0000-0000000008b1';
const OWNER_A = 'ffffffff-0000-0000-0000-0000000008a2';

const app = new OpenAPIHono();
app.route('/', adminSettings);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'host-a', 'A', 'USD', $2) ON CONFLICT (id) DO NOTHING`, [STORE_A, JSON.stringify({ hostnames: ['a.example.test'] })]);
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'host-b', 'B', 'USD', $2) ON CONFLICT (id) DO NOTHING`, [STORE_B, JSON.stringify({ hostnames: ['shop.b-brand.test'] })]);
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'owner@hosts.test') ON CONFLICT (id) DO NOTHING`, [OWNER_A]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [OWNER_A, STORE_A]);
  return createAdminSession(OWNER_A);
}

const patch = (token: string, hostnames: unknown) => app.request('/v1/admin/settings/store', {
  method: 'PATCH',
  headers: { authorization: `Bearer ${token}`, 'x-store-slug': 'host-a', 'content-type': 'application/json' },
  body: JSON.stringify({ hostnames }),
});
const hostsOf = async () => ((await withStore(STORE_A, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, STORE_A))))[0]!.config as { hostnames?: string[] }).hostnames;

beforeEach(wipe);
afterAll(async () => { await wipe(); await pool.end(); });

describe('hostnames admin setting', () => {
  it('accepts and normalises valid FQDNs', async () => {
    const token = await seed();
    expect((await patch(token, ['New.Example.test', 'www.new.example.test'])).status).toBe(200);
    expect(await hostsOf()).toEqual(['new.example.test', 'www.new.example.test']);
  });

  it('rejects bare TLDs, single labels, wildcards and URLs without changing config', async () => {
    const token = await seed();
    for (const bad of ['com', 'localhost', '*.example.test', 'https://x.example.test', 'x.example.test:8443']) {
      expect((await patch(token, ['ok.example.test', bad])).status, bad).toBe(400);
    }
    expect(await hostsOf()).toEqual(['a.example.test']);
  });

  it('rejects a hostname that another store already uses, or that overlaps it as a parent or subdomain', async () => {
    const token = await seed();
    for (const taken of ['shop.b-brand.test', 'b-brand.test', 'x.shop.b-brand.test']) {
      const res = await patch(token, [taken]);
      expect(res.status, taken).toBe(409);
    }
    expect(await hostsOf()).toEqual(['a.example.test']);
  });

  it('a store may keep re-saving its own hostnames', async () => {
    const token = await seed();
    expect((await patch(token, ['a.example.test', 'www.a.example.test'])).status).toBe(200);
  });
});
