/**
 * DB-layer tests for the ported activation-engine delta:
 *   - bounded device pools on the legacy activate path (policy-driven, never
 *     hardcoded app keys / pool sizes)
 *   - state-aware seat counting (tombstoned activations free their seat)
 *   - tombstoned activations are invisible to findActivationByToken
 *   - deactivateDevice idempotency
 *   - canonical entitlement issuance recording + inventory gate
 *   - hard-expiry boundary at second precision
 *   - cross-tenant isolation
 *
 * Runs against a *_test database (TRUNCATEs). vitest runs DB files serially.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import {
  activateLicenseOnDevice,
  deactivateDevice,
  findActivationByToken,
  getEntitlementIssuanceInventory,
  recordCanonicalEntitlementIssuance,
} from './activations.js';
import { clearDevicePolicies, registerDevicePolicy } from './device-policy.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`activations-engine test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STORE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MARKER = 'testapp_2c_2m_v1';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  clearDevicePolicies();
  registerDevicePolicy('testapp', {
    marker: MARKER,
    poolCaps: { computer: 2, mobile: 2 },
    pooledSeats: true,
  });
}

async function seed(storeId: string) {
  await withStore(storeId, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${storeId}, ${storeId}, ${storeId}) ON CONFLICT (id) DO NOTHING`);
  });
}

async function seedLicense(opts: {
  storeId?: string; licenseKey: string; appKey?: string; seats?: number;
  status?: string; expiresAt?: string | null; metadata?: unknown;
}): Promise<string> {
  const { storeId = STORE_A, licenseKey, appKey = 'testapp', seats = 2, status = 'active', expiresAt = null, metadata = null } = opts;
  return withStore(storeId, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${storeId}, ${storeId}, ${storeId}) ON CONFLICT (id) DO NOTHING`);
    const r = await tx.execute(sql`
      INSERT INTO license (id, store_id, app_key, license_key, status, seats, expires_at, metadata, source)
      VALUES (gen_random_uuid(), ${storeId}, ${appKey}, ${licenseKey}, ${status}::license_status, ${seats},
              ${expiresAt}::timestamptz, ${metadata == null ? null : JSON.stringify(metadata)}::jsonb, 'admin')
      RETURNING id
    `);
    return (r.rows[0] as { id: string }).id;
  });
}

beforeEach(wipe);
afterEach(wipe);
afterAll(() => pool.end());

describe('bounded device pools on the legacy activate path', () => {
  it('caps each pool at the policy limit — third computer is full, mobile unaffected', async () => {
    await seedLicense({ licenseKey: 'pool-cap-1', seats: 0, metadata: { device_policy: MARKER } });
    for (const dev of ['c1', 'c2']) {
      const r = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
        storeId: STORE_A, appKey: 'testapp', licenseKey: 'pool-cap-1', deviceId: dev, activationSource: 'desktop',
      }));
      expect(r.kind).toBe('ok');
    }
    const third = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'pool-cap-1', deviceId: 'c3', activationSource: 'desktop',
    }));
    expect(third.kind).toBe('full');
  });

  it('does not bound an unmarked seats=0 license (grandfathered unlimited)', async () => {
    await seedLicense({ licenseKey: 'gf-1', seats: 0 });
    for (const dev of ['a', 'b', 'c', 'd']) {
      const r = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
        storeId: STORE_A, appKey: 'testapp', licenseKey: 'gf-1', deviceId: dev, activationSource: 'desktop',
      }));
      expect(r.kind).toBe('ok');
    }
  });

  it('positive seats stay bounded even without the marker', async () => {
    await seedLicense({ licenseKey: 'seats-2', seats: 2 });
    for (const dev of ['a', 'b']) {
      const r = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
        storeId: STORE_A, appKey: 'testapp', licenseKey: 'seats-2', deviceId: dev, activationSource: 'desktop',
      }));
      expect(r.kind).toBe('ok');
    }
    const third = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'seats-2', deviceId: 'c', activationSource: 'desktop',
    }));
    expect(third.kind).toBe('full');
  });

  it('an app with no registered policy keeps flat seat semantics and writes no pool', async () => {
    await seedLicense({ licenseKey: 'flat-1', appKey: 'flatapp', seats: 2 });
    const r = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'flatapp', licenseKey: 'flat-1', deviceId: 'd1', activationSource: 'desktop',
    }));
    expect(r.kind).toBe('ok');
    const row = await withStore(STORE_A, async (tx) => {
      const x = await tx.execute(sql`SELECT pool, device_class FROM license_activation WHERE app_key = 'flatapp' LIMIT 1`);
      return x.rows[0] as { pool: string | null; device_class: string | null };
    });
    expect(row.pool).toBeNull();
    expect(row.device_class).toBeNull();
  });
});

describe('activation state accounting', () => {
  it('a tombstoned activation frees its seat and its token stops resolving', async () => {
    await seedLicense({ licenseKey: 'state-1', seats: 1 });
    const first = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'state-1', deviceId: 'dev-a',
    }));
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') throw new Error('unreachable');

    // Tombstone the row directly (as remote-revoke does), leaving the token hash.
    await withStore(STORE_A, (tx) => tx.execute(sql`
      UPDATE license_activation SET state = 'revoked', revoked_at = now() WHERE id = ${first.activationId}
    `));

    // Seat freed: a different device can activate.
    const second = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'state-1', deviceId: 'dev-b',
    }));
    expect(second.kind).toBe('ok');

    // The revoked row's token no longer resolves.
    const found = await withStore(STORE_A, (tx) => findActivationByToken(tx, { appKey: 'testapp', activationToken: first.activationToken }));
    expect(found).toBeNull();
  });

  it('re-activating the same device clears the tombstone', async () => {
    await seedLicense({ licenseKey: 'state-2', seats: 1 });
    const first = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'state-2', deviceId: 'dev-a',
    }));
    if (first.kind !== 'ok') throw new Error('unreachable');
    await withStore(STORE_A, (tx) => tx.execute(sql`
      UPDATE license_activation SET state = 'revoked', revoked_at = now() WHERE id = ${first.activationId}
    `));
    const second = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'state-2', deviceId: 'dev-a',
    }));
    expect(second.kind).toBe('ok');
    const row = await withStore(STORE_A, async (tx) => {
      const x = await tx.execute(sql`SELECT state, revoked_at FROM license_activation WHERE id = ${first.activationId}`);
      return x.rows[0] as { state: string; revoked_at: string | null };
    });
    expect(row.state).toBe('active');
    expect(row.revoked_at).toBeNull();
  });
});

describe('deactivateDevice', () => {
  it('removes the row and is idempotent', async () => {
    await seedLicense({ licenseKey: 'deact-1', seats: 1 });
    const first = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'deact-1', deviceId: 'dev-a',
    }));
    if (first.kind !== 'ok') throw new Error('unreachable');
    const r1 = await withStore(STORE_A, (tx) => deactivateDevice(tx, { appKey: 'testapp', activationToken: first.activationToken }));
    expect(r1.kind).toBe('ok');
    const r2 = await withStore(STORE_A, (tx) => deactivateDevice(tx, { appKey: 'testapp', activationToken: first.activationToken }));
    expect(r2.kind).toBe('ok');
    const n = await withStore(STORE_A, async (tx) => {
      const x = await tx.execute(sql`SELECT count(*)::int AS n FROM license_activation WHERE app_key = 'testapp'`);
      return (x.rows[0] as { n: number }).n;
    });
    expect(n).toBe(0);
  });
});

describe('canonical entitlement issuance', () => {
  it('records issuance for an active license and refuses for a revoked one', async () => {
    const licId = await seedLicense({ licenseKey: 'canon-1', seats: 1 });
    const act = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'canon-1', deviceId: 'dev-a',
    }));
    if (act.kind !== 'ok') throw new Error('unreachable');

    const ok = await withStore(STORE_A, (tx) => recordCanonicalEntitlementIssuance(tx, { activationId: act.activationId, appKey: 'testapp' }));
    expect(ok).toBe(true);

    const inv = await withStore(STORE_A, (tx) => getEntitlementIssuanceInventory(tx, { appKey: 'testapp' }));
    expect(inv).toEqual({ canonicalV2: 1, legacyOrUnknown: 0, canRemoveLegacyVerifier: true });

    // Revoke the license → recording must fail (refund/revocation linearization).
    await withStore(STORE_A, (tx) => tx.execute(sql`UPDATE license SET status = 'revoked' WHERE id = ${licId}`));
    const refused = await withStore(STORE_A, (tx) => recordCanonicalEntitlementIssuance(tx, { activationId: act.activationId, appKey: 'testapp' }));
    expect(refused).toBe(false);
  });

  it('refuses to record issuance for a tombstoned activation', async () => {
    await seedLicense({ licenseKey: 'canon-2', seats: 1 });
    const act = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'canon-2', deviceId: 'dev-a',
    }));
    if (act.kind !== 'ok') throw new Error('unreachable');
    await withStore(STORE_A, (tx) => tx.execute(sql`UPDATE license_activation SET state = 'removed' WHERE id = ${act.activationId}`));
    const ok = await withStore(STORE_A, (tx) => recordCanonicalEntitlementIssuance(tx, { activationId: act.activationId, appKey: 'testapp' }));
    expect(ok).toBe(false);
  });

  it('inventory counts legacy/unknown activations as blocking', async () => {
    await seedLicense({ licenseKey: 'inv-1', seats: 3 });
    await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'testapp', licenseKey: 'inv-1', deviceId: 'd1' }));
    const act2 = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'testapp', licenseKey: 'inv-1', deviceId: 'd2' }));
    if (act2.kind !== 'ok') throw new Error('unreachable');
    await withStore(STORE_A, (tx) => recordCanonicalEntitlementIssuance(tx, { activationId: act2.activationId, appKey: 'testapp' }));
    const inv = await withStore(STORE_A, (tx) => getEntitlementIssuanceInventory(tx, { appKey: 'testapp' }));
    expect(inv.canonicalV2).toBe(1);
    expect(inv.legacyOrUnknown).toBe(1);
    expect(inv.canRemoveLegacyVerifier).toBe(false);
  });
});

describe('hard-expiry boundary', () => {
  it('a license expiring within the current second is already inactive', async () => {
    const now = new Date();
    await seedLicense({ licenseKey: 'exp-boundary', seats: 1, expiresAt: new Date(now.getTime() - 1).toISOString() });
    const r = await withStore(STORE_A, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_A, appKey: 'testapp', licenseKey: 'exp-boundary', deviceId: 'dev-a',
    }));
    expect(r.kind).toBe('notfound');
  });
});

describe('cross-tenant isolation', () => {
  it('store B cannot activate or introspect store A licenses', async () => {
    await seed(STORE_B);
    await seedLicense({ licenseKey: 'tenant-a-key', seats: 1 });
    const r = await withStore(STORE_B, (tx) => activateLicenseOnDevice(tx, {
      storeId: STORE_B, appKey: 'testapp', licenseKey: 'tenant-a-key', deviceId: 'intruder',
    }));
    expect(r.kind).toBe('notfound');
    const inv = await withStore(STORE_B, (tx) => getEntitlementIssuanceInventory(tx, {}));
    expect(inv).toEqual({ canonicalV2: 0, legacyOrUnknown: 0, canRemoveLegacyVerifier: true });
  });
});
