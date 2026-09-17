/**
 * DB-layer test for mintLicense — the order-less (comp/support/creator) issue
 * path with EXPLICIT provenance. Runs against a *_test database (TRUNCATEs),
 * mirroring activations.test.ts (vitest runs DB files serially).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { mintLicense } from './mint.js';
import { activateLicenseOnDevice } from './activations.js';
import { clearDevicePolicies, registerDevicePolicy } from './device-policy.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `mint test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  clearDevicePolicies();
}
async function seedStore() {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${STORE}, ${STORE}) ON CONFLICT (id) DO NOTHING`);
  });
}

beforeEach(async () => { await wipe(); await seedStore(); });
afterEach(wipe);
afterAll(() => pool.end());

describe('mintLicense', () => {
  it('mints an order-less license with explicit provenance that activates and binds a device', async () => {
    await withStore(STORE, async (tx) => {
      const { licenseId, licenseKey } = await mintLicense(tx, {
        storeId: STORE, appKey: 'testapp', seats: 50, updatesUntil: null, expiresAt: null,
        issuedBy: 'admin@example.com', reason: 'support comp — ticket 123',
      });
      expect(licenseId).toMatch(/[0-9a-f-]{8}-[0-9a-f-]{4}/);

      const r = await tx.execute(sql`SELECT source, order_id, order_line_id, seats, issued_by, issue_reason FROM license WHERE id = ${licenseId}`);
      expect(r.rows[0]).toEqual({
        source: 'admin',
        order_id: null,
        order_line_id: null,
        seats: 50,
        issued_by: 'admin@example.com',
        issue_reason: 'support comp — ticket 123',
      });

      const out = await activateLicenseOnDevice(tx, { storeId: STORE, appKey: 'testapp', licenseKey, deviceId: 'mac-1' });
      expect(out.kind).toBe('ok');
    });
  });

  it('mints with a fixed key + a hard expiry', async () => {
    await withStore(STORE, async (tx) => {
      const expiresAt = new Date(Date.now() + 365 * 86_400_000);
      const { licenseKey } = await mintLicense(tx, {
        storeId: STORE, appKey: 'otherapp', seats: 1, updatesUntil: expiresAt, expiresAt,
        licenseKey: 'CREATOR-OTHERAPP', issuedBy: 'owner@example.com', reason: 'creator key',
      });
      expect(licenseKey).toBe('CREATOR-OTHERAPP');
      const r = await tx.execute(sql`SELECT (expires_at IS NOT NULL) AS bounded FROM license WHERE license_key = 'CREATOR-OTHERAPP'`);
      expect(r.rows[0]).toEqual({ bounded: true });
    });
  });

  it('refuses orderless issuance without explicit provenance', async () => {
    await withStore(STORE, async (tx) => {
      await expect(mintLicense(tx, {
        storeId: STORE, appKey: 'testapp', seats: 1, updatesUntil: null, expiresAt: null,
        issuedBy: '', reason: 'x',
      } as never)).rejects.toThrow(/provenance/i);
      await expect(mintLicense(tx, {
        storeId: STORE, appKey: 'testapp', seats: 1, updatesUntil: null, expiresAt: null,
        issuedBy: 'admin@example.com', reason: '   ',
      })).rejects.toThrow(/provenance/i);
    });
  });

  it('applies the registered device-policy marker and pooled seats on mint', async () => {
    registerDevicePolicy('poolapp', { marker: 'pool_v1', poolCaps: { computer: 2 }, pooledSeats: true });
    await withStore(STORE, async (tx) => {
      const { licenseId } = await mintLicense(tx, {
        storeId: STORE, appKey: 'poolapp', seats: 9, updatesUntil: null, expiresAt: null,
        issuedBy: 'admin@example.com', reason: 'comp',
      });
      const r = await tx.execute(sql`SELECT seats, metadata->>'device_policy' AS dp FROM license WHERE id = ${licenseId}`);
      expect(r.rows[0]).toEqual({ seats: 0, dp: 'pool_v1' });
    });
  });
});
