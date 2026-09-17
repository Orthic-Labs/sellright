/**
 * DB-layer tests for the generic account-linked device-lease engine.
 * Mirrors activations.test.ts's pattern (real Postgres, TRUNCATE-based
 * isolation, withStore per operation).
 *
 * Suite values (pool caps, policy markers, lease windows) come from the
 * registered per-app device policy — never hardcoded in the engine.
 *
 * Abuse/negative coverage:
 *   - a client claiming a companion platform to dodge a seat is rejected
 *   - a replayed (stale) leaseId on renew is rejected
 *   - concurrent issuance races the pool cap correctly (no over-admission)
 *   - grandfathered seats<=0 licenses stay unlimited without the policy marker
 *   - cross-tenant isolation under FORCE RLS
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import {
  issueDeviceLease,
  renewDeviceLease,
  revokeDeviceRemote,
  removeDeviceOffline,
} from './device-leases.js';
import { clearDevicePolicies, registerDevicePolicy } from './device-policy.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`device-leases test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const STORE_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
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

async function seedLicense(opts: { licenseKey: string; appKey?: string; seats?: number; metadata?: unknown; storeId?: string }): Promise<string> {
  const { licenseKey, appKey = 'testapp', seats = 0, metadata = null, storeId = STORE } = opts;
  return withStore(storeId, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${storeId}, ${storeId}, ${storeId}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO license (id, store_id, app_key, license_key, status, seats, metadata, source)
      VALUES (gen_random_uuid(), ${storeId}, ${appKey}, ${licenseKey}, 'active'::license_status, ${seats}, ${metadata == null ? null : JSON.stringify(metadata)}::jsonb, 'admin')
    `);
    const r = await tx.execute(sql`SELECT id FROM license WHERE license_key = ${licenseKey} AND store_id = ${storeId} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
}

const hashish = (label: string) => `${label}${'0'.repeat(64 - label.length)}`;

beforeEach(wipe);
afterEach(wipe);
afterAll(() => pool.end());

describe('issueDeviceLease — pool enforcement from registered policy', () => {
  it('rejects a client claiming a companion platform (cannot dodge a seat)', async () => {
    await seedLicense({ licenseKey: 'watch-dodge-1', seats: 2 });
    const out = await withStore(STORE, (tx) => issueDeviceLease(tx, {
      storeId: STORE, appKey: 'testapp', licenseKey: 'watch-dodge-1',
      deviceIdHash: hashish('watchclaim'), platform: 'watchos',
    }));
    expect(out.kind).toBe('rejected_platform');
  });

  it('rejects an unknown platform', async () => {
    await seedLicense({ licenseKey: 'bad-plat-1', seats: 2 });
    const out = await withStore(STORE, (tx) => issueDeviceLease(tx, {
      storeId: STORE, appKey: 'testapp', licenseKey: 'bad-plat-1',
      deviceIdHash: hashish('dev'), platform: 'toasteros',
    }));
    expect(out.kind).toBe('rejected_platform');
  });

  it('enforces the configured computer pool cap (macOS + Windows + Linux share it)', async () => {
    await seedLicense({ licenseKey: 'computer-cap-1', seats: 2 });
    const r1 = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'computer-cap-1', deviceIdHash: hashish('mac1'), platform: 'macos' }));
    expect(r1.kind).toBe('ok');
    const r2 = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'computer-cap-1', deviceIdHash: hashish('win1'), platform: 'windows' }));
    expect(r2.kind).toBe('ok');
    const r3 = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'computer-cap-1', deviceIdHash: hashish('mac2'), platform: 'linux' }));
    expect(r3.kind).toBe('full');
  });

  it('enforces the mobile pool cap independently of the computer pool', async () => {
    await seedLicense({ licenseKey: 'mobile-cap-1', seats: 2 });
    await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'mobile-cap-1', deviceIdHash: hashish('ip1'), platform: 'ios' }));
    await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'mobile-cap-1', deviceIdHash: hashish('ipad1'), platform: 'ipados' }));
    const macOk = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'mobile-cap-1', deviceIdHash: hashish('mac1'), platform: 'macos' }));
    expect(macOk.kind).toBe('ok');
    const thirdMobile = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'mobile-cap-1', deviceIdHash: hashish('ip2'), platform: 'ios' }));
    expect(thirdMobile.kind).toBe('full');
  });

  it('concurrent issuance races the pool cap correctly — exactly cap of N simultaneous requests win', async () => {
    await seedLicense({ licenseKey: 'concurrent-cap-1', seats: 2 });
    const attempts = ['a', 'b', 'c', 'd', 'e'].map((label) =>
      withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'concurrent-cap-1', deviceIdHash: hashish(`race-${label}`), platform: 'macos' })));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(2);
    expect(results.filter((r) => r.kind === 'full')).toHaveLength(3);
  });

  it('grandfathered seats=0 (no policy marker) stays unlimited under the pool model', async () => {
    await seedLicense({ licenseKey: 'grandfathered-1', seats: 0 });
    for (const label of ['a', 'b', 'c', 'd', 'e']) {
      const r = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'grandfathered-1', deviceIdHash: hashish(`gf-${label}`), platform: 'macos' }));
      expect(r.kind).toBe('ok');
    }
  });

  it('new seats=0 license carrying the policy marker enforces the pool cap', async () => {
    await seedLicense({ licenseKey: 'bounded-zero-1', seats: 0, metadata: { device_policy: MARKER } });
    for (const label of ['a', 'b']) {
      const r = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'bounded-zero-1', deviceIdHash: hashish(`bounded-${label}`), platform: 'macos' }));
      expect(r.kind).toBe('ok');
    }
    const third = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'bounded-zero-1', deviceIdHash: hashish('bounded-c'), platform: 'windows' }));
    expect(third.kind).toBe('full');
  });

  it('an app with NO registered policy falls back to the flat seat count', async () => {
    await seedLicense({ licenseKey: 'flat-1', appKey: 'flatapp', seats: 2 });
    await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'flatapp', licenseKey: 'flat-1', deviceIdHash: hashish('d1'), platform: 'macos' }));
    await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'flatapp', licenseKey: 'flat-1', deviceIdHash: hashish('d2'), platform: 'ios' }));
    const third = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'flatapp', licenseKey: 'flat-1', deviceIdHash: hashish('d3'), platform: 'windows' }));
    expect(third.kind).toBe('full');
  });

  it('same-device re-issue is idempotent and does not consume an extra pool slot', async () => {
    await seedLicense({ licenseKey: 'idempotent-1', seats: 2 });
    const dev = hashish('same-device');
    const r1 = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'idempotent-1', deviceIdHash: dev, platform: 'macos' }));
    expect(r1.kind).toBe('ok');
    const r2 = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'idempotent-1', deviceIdHash: dev, platform: 'macos' }));
    expect(r2.kind).toBe('ok');
    const r3 = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'idempotent-1', deviceIdHash: hashish('other'), platform: 'macos' }));
    expect(r3.kind).toBe('ok');
  });

  it('cannot touch another store\u2019s license (RLS + explicit store predicate)', async () => {
    await seedLicense({ licenseKey: 'tenant-key', storeId: STORE_B, seats: 2 });
    const out = await withStore(STORE, (tx) => issueDeviceLease(tx, {
      storeId: STORE, appKey: 'testapp', licenseKey: 'tenant-key',
      deviceIdHash: hashish('intruder'), platform: 'macos',
    }));
    expect(out.kind).toBe('notfound');
  });
});

describe('renewDeviceLease — replay rejection', () => {
  it('rejects a renew that presents a stale (already-rotated) leaseId', async () => {
    await seedLicense({ licenseKey: 'replay-1', seats: 2 });
    const dev = hashish('replay-dev');
    const issued = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'replay-1', deviceIdHash: dev, platform: 'macos' }));
    expect(issued.kind).toBe('ok');
    if (issued.kind !== 'ok') throw new Error('unreachable');
    const staleLeaseId = issued.lease.leaseId;

    const renewed = await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: staleLeaseId }));
    expect(renewed.kind).toBe('ok');
    if (renewed.kind !== 'ok') throw new Error('unreachable');
    expect(renewed.lease.leaseId).not.toBe(staleLeaseId);

    const replay = await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: staleLeaseId }));
    expect(replay.kind).toBe('notfound');

    const renewAgain = await withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: renewed.lease.leaseId }));
    expect(renewAgain.kind).toBe('ok');
  });

  it('concurrent renews of the same leaseId produce exactly one winner', async () => {
    await seedLicense({ licenseKey: 'renew-race-1', seats: 2 });
    const dev = hashish('renew-race-dev');
    const issued = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'renew-race-1', deviceIdHash: dev, platform: 'macos' }));
    if (issued.kind !== 'ok') throw new Error('unreachable');
    const results = await Promise.all([
      withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: issued.lease.leaseId })),
      withStore(STORE, (tx) => renewDeviceLease(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: issued.lease.leaseId })),
    ]);
    // Serialized on the activation row: exactly one wins; the loser sees the
    // rotated leaseId and is rejected as a replay.
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.kind !== 'ok')).toHaveLength(1);
  });
});

describe('revokeDeviceRemote / removeDeviceOffline — tombstone + seat release', () => {
  it('remote revoke keeps a tombstone row, bumps generation, and immediately frees the pool slot', async () => {
    await seedLicense({ licenseKey: 'revoke-1', seats: 2 });
    const devA = hashish('revoke-a');
    const devB = hashish('revoke-b');
    const a = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'revoke-1', deviceIdHash: devA, platform: 'macos' }));
    const b = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'revoke-1', deviceIdHash: devB, platform: 'windows' }));
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    if (a.kind !== 'ok') throw new Error('unreachable');

    const licenseId = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT license_id FROM license_activation WHERE id = ${a.activationId}`);
      return (r.rows[0] as { license_id: string }).license_id;
    });

    const revoked = await withStore(STORE, (tx) => revokeDeviceRemote(tx, { storeId: STORE, licenseId, activationId: a.activationId }));
    expect(revoked.kind).toBe('ok');

    const row = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT state, generation, revoked_at FROM license_activation WHERE id = ${a.activationId}`);
      return r.rows[0] as { state: string; generation: number; revoked_at: string | null };
    });
    expect(row.state).toBe('revoked');
    expect(row.generation).toBe(1);
    expect(row.revoked_at).not.toBeNull();

    const revokedAgain = await withStore(STORE, (tx) => revokeDeviceRemote(tx, { storeId: STORE, licenseId, activationId: a.activationId }));
    expect(revokedAgain.kind).toBe('ok');

    const c = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'revoke-1', deviceIdHash: hashish('revoke-c'), platform: 'macos' }));
    expect(c.kind).toBe('ok');
  });

  it('offline local removal is idempotent and frees the seat', async () => {
    await seedLicense({ licenseKey: 'offline-remove-1', seats: 1 });
    const dev = hashish('offline-dev');
    const a = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'offline-remove-1', deviceIdHash: dev, platform: 'macos' }));
    expect(a.kind).toBe('ok');
    if (a.kind !== 'ok') throw new Error('unreachable');

    await withStore(STORE, (tx) => removeDeviceOffline(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: a.lease.leaseId }));
    await withStore(STORE, (tx) => removeDeviceOffline(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: a.lease.leaseId }));

    const other = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'offline-remove-1', deviceIdHash: hashish('offline-other'), platform: 'macos' }));
    expect(other.kind).toBe('ok');
  });

  it('a delayed removal cannot revoke a later lease for the same device', async () => {
    await seedLicense({ licenseKey: 'offline-remove-stale', seats: 1 });
    const dev = hashish('offline-stale-device');
    const first = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'offline-remove-stale', deviceIdHash: dev, platform: 'windows' }));
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') throw new Error('unreachable');
    await withStore(STORE, (tx) => removeDeviceOffline(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: first.lease.leaseId }));

    const second = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'offline-remove-stale', deviceIdHash: dev, platform: 'windows' }));
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') throw new Error('unreachable');
    expect(second.lease.leaseId).not.toBe(first.lease.leaseId);

    await withStore(STORE, (tx) => removeDeviceOffline(tx, { storeId: STORE, appKey: 'testapp', deviceIdHash: dev, leaseId: first.lease.leaseId }));
    const stillActive = await withStore(STORE, (tx) => renewDeviceLease(tx, {
      storeId: STORE,
      appKey: 'testapp',
      deviceIdHash: dev,
      leaseId: second.lease.leaseId,
    }));
    expect(stillActive.kind).toBe('ok');
  });

  it('a revoked device\u2019s activation token no longer resolves', async () => {
    const { findActivationByToken } = await import('./activations.js');
    await seedLicense({ licenseKey: 'revoke-token-1', seats: 2 });
    const issued = await withStore(STORE, (tx) => issueDeviceLease(tx, { storeId: STORE, appKey: 'testapp', licenseKey: 'revoke-token-1', deviceIdHash: hashish('revtok'), platform: 'macos' }));
    if (issued.kind !== 'ok') throw new Error('unreachable');
    const licenseId = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT license_id FROM license_activation WHERE id = ${issued.activationId}`);
      return (r.rows[0] as { license_id: string }).license_id;
    });
    await withStore(STORE, (tx) => revokeDeviceRemote(tx, { storeId: STORE, licenseId, activationId: issued.activationId }));
    const found = await withStore(STORE, (tx) => findActivationByToken(tx, { appKey: 'testapp', activationToken: issued.activationToken }));
    expect(found).toBeNull();
  });
});
