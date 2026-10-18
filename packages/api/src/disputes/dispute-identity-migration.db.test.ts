import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase } from '../db/rls-test-utils.js';

const url = process.env.DATABASE_URL ?? '';
assertTestDatabase(url, 'NMI dispute identity migration fixture');
const pool = new Pool({ connectionString: url, max: 1 });
const migration = readFileSync(new URL('../../drizzle/0106_nmi_dispute_identity.sql', import.meta.url), 'utf8');
afterAll(() => pool.end());

describe('NMI dispute identity migration', () => {
  it('backfills only linked proof across FORCE-RLS tenants & preserves old insert shapes', async () => {
    const client = await pool.connect();
    const schema = `dispute_identity_${randomUUID().replaceAll('-', '')}`;
    const stores = [randomUUID(), randomUUID()];
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE store (id uuid PRIMARY KEY);
        CREATE TABLE payment (id uuid PRIMARY KEY, store_id uuid, order_id uuid,
          method text, provider_ref text, gateway_account text, gateway_mode text);
        CREATE TABLE dispute (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), store_id uuid,
          provider text, provider_ref text, payment_id uuid, order_id uuid,
          details jsonb, notified_at timestamptz);
        CREATE UNIQUE INDEX dispute_provider_ref_key ON dispute (store_id, provider, provider_ref);
      `);
      const unchanged: Array<Record<string, unknown>> = [];
      for (const storeId of stores) {
        await client.query('INSERT INTO store VALUES ($1)', [storeId]);
        for (const kind of ['exact', 'no-order', 'wrong-method', 'wrong-ref', 'wrong-order', 'wrong-store', 'blank', 'partial', 'null-account', 'invalid-mode', 'unlinked', 'stripe']) {
          const paymentId = randomUUID(), orderId = randomUUID();
          const providerRef = `${kind}-ref`;
          await client.query(`INSERT INTO payment VALUES ($1,$2,$3,$4,$5,$6,$7)`, [paymentId, kind === 'wrong-store' ? stores.find(id => id !== storeId) : storeId, orderId,
            kind === 'wrong-method' ? 'stripe' : 'nmi', kind === 'wrong-ref' ? 'other-ref' : providerRef,
            kind === 'null-account' ? null : kind === 'blank' ? '  ' : 'account', kind === 'partial' ? null : kind === 'invalid-mode' ? 'sandbox' : 'live']);
          const inserted = await client.query(`INSERT INTO dispute
            (store_id,provider,provider_ref,payment_id,order_id,details,notified_at)
            VALUES ($1,$2,$3,$4,$5,'{"preserved":true}', '2025-01-01') RETURNING *`, [storeId,
            kind === 'stripe' ? 'stripe' : 'nmi', providerRef, kind === 'unlinked' ? null : paymentId,
            kind === 'no-order' ? null : kind === 'wrong-order' ? randomUUID() : orderId]);
          unchanged.push(inserted.rows[0]);
        }
      }
      for (const table of ['payment', 'dispute']) {
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON ${table}
          USING (store_id = nullif(current_setting('app.current_store', true), '')::uuid)
          WITH CHECK (store_id = nullif(current_setting('app.current_store', true), '')::uuid)`);
      }
      await client.query("SELECT set_config('app.current_store', $1, true)", [stores[0]]);
      await client.query(migration);
      expect((await client.query("SELECT current_setting('app.current_store') AS scope")).rows[0].scope).toBe(stores[0]);
      const force = await client.query(`SELECT relforcerowsecurity FROM pg_class WHERE oid IN ('payment'::regclass, 'dispute'::regclass)`);
      expect(force.rows).toEqual([{ relforcerowsecurity: true }, { relforcerowsecurity: true }]);
      for (const storeId of stores) {
        await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
        const rows = (await client.query('SELECT * FROM dispute ORDER BY provider_ref')).rows;
        expect(rows).toHaveLength(12);
        for (const row of rows) {
          const prior = unchanged.find(old => old.id === row.id)!;
          const { gateway_account, gateway_mode, ...rest } = row;
          expect(rest).toEqual(prior);
          expect([gateway_account, gateway_mode]).toEqual(['exact-ref', 'no-order-ref'].includes(row.provider_ref)
            ? ['account', 'live'] : [null, null]);
        }
        // Pre-expansion caller: omitted columns & untargeted conflict remain legal.
        await client.query(`INSERT INTO dispute (store_id,provider,provider_ref) VALUES ($1,'nmi','old-shape') ON CONFLICT DO NOTHING`, [storeId]);
        await client.query(`INSERT INTO dispute (store_id,provider,provider_ref) VALUES ($1,'nmi','old-shape') ON CONFLICT DO NOTHING`, [storeId]);
        // Unresolved history & four authenticated scopes coexist; each exact replay dedupes.
        for (const account of ['account', 'other-account']) for (const mode of ['live', 'test']) {
          for (let replay = 0; replay < 2; replay++) await client.query(`INSERT INTO dispute
            (store_id,provider,provider_ref,gateway_account,gateway_mode) VALUES ($1,'nmi','old-shape',$2,$3) ON CONFLICT DO NOTHING`, [storeId, account, mode]);
        }
        expect((await client.query("SELECT count(*)::int AS n FROM dispute WHERE provider_ref = 'old-shape'")).rows[0].n).toBe(5);
        await client.query(`INSERT INTO dispute (store_id,provider,provider_ref) VALUES ($1,'stripe','stripe-ref') ON CONFLICT DO NOTHING`, [storeId]);
        expect((await client.query("SELECT count(*)::int AS n FROM dispute WHERE provider = 'stripe' AND provider_ref = 'stripe-ref'")).rows[0].n).toBe(1);
      }
      for (const [provider, account, mode] of [['nmi', 'account', null], ['nmi', null, 'live'],
        ['nmi', '', 'live'], ['nmi', 'account', 'sandbox'], ['stripe', 'account', 'live']]) {
        await client.query('SAVEPOINT invalid_identity');
        await expect(client.query(`INSERT INTO dispute (store_id,provider,provider_ref,gateway_account,gateway_mode)
          VALUES ($1,$2,'invalid',$3,$4)`, [stores[1], provider, account, mode])).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT invalid_identity');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
