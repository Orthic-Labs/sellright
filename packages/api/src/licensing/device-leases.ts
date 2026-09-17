// Generic account-linked device-lease engine. Additive on top of the existing
// license_activation table (the flat-seat logic in activations.ts stays
// untouched for the legacy raw-deviceId activate route).
//
// This module is the device-lease model consumed by account-linked endpoints:
// it accepts a pre-hashed `deviceIdHash` (never a raw device id — the client
// hashes client-side, per the wire contract), derives `pool` from `platform`
// SERVER-SIDE (never client-supplied), and issues/renews/revokes a signed,
// renewable lease with an explicit offline-grace window.
//
// All suite values — which app uses pools, pool caps, lease windows, the
// platform→pool mapping — come from the registered per-app device policy
// (device-policy.ts), populated from store config / product metadata.
import { randomUUID, createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { newActivationToken, hashActivationToken } from './tokens.js';
import { signEntitlement, signLeaseEnvelope } from './sign.js';
import { buildEntitlements } from './entitlements.js';
import {
  derivePool,
  devicePolicyFor,
  leaseGraceSecondsFor,
  leaseTtlSecondsFor,
  leasablePool,
  poolCap,
  usesBoundedDevicePools,
  type ActivationPool,
} from './device-policy.js';

export type { ActivationPool } from './device-policy.js';
export type Platform = string;
export type Pool = ActivationPool;

/** Legacy storage values retained for reads and migration compatibility —
 *  written to the device_class column purely so back-compat readers
 *  (dashboards, the pre-existing pool-agnostic seat check) still see something
 *  sane. `platform`/`pool` are authoritative for every new code path. */
function legacyDeviceClassFor(platform: string): string {
  if (platform === 'macos') return 'mac';
  if (platform === 'windows') return 'windows';
  if (platform === 'ios' || platform === 'ipados') return 'iphone';
  if (platform === 'android') return 'android';
  if (platform === 'watchos') return 'watch';
  return platform;
}

const hashDeviceId = (raw: string) => createHash('sha256').update(raw).digest('hex');

export interface LeaseEnvelope {
  leaseId: string;
  deviceIdHash: string;
  pool: ActivationPool;
  entitlement: string | null;
  issuedAt: string;
  expiresAt: string;
  graceSeconds: number;
  generation: number;
  signature: string | null;
}

// Canonical envelope bytes signed by signLeaseEnvelope — fixed field order,
// no whitespace, EXCLUDES `entitlement`/`signature` (entitlement is its own
// independently-signed token; signature covers the envelope metadata only).
function canonicalLeaseEnvelope(e: Omit<LeaseEnvelope, 'entitlement' | 'signature'>): string {
  return JSON.stringify({
    leaseId: e.leaseId, deviceIdHash: e.deviceIdHash, pool: e.pool,
    issuedAt: e.issuedAt, expiresAt: e.expiresAt, graceSeconds: e.graceSeconds, generation: e.generation,
  });
}

type LicRow = { id: string; status: string; seats: number; expiresAt: Date | null; appKey: string; metadata: unknown; createdAt: Date };

async function lockActiveLicense(tx: Tx, input: { storeId: string; appKey: string; licenseKey: string }): Promise<LicRow | null> {
  const res = await tx.execute(sql`
    SELECT id, status, seats, expires_at, app_key, metadata, created_at
    FROM license
    WHERE license_key = ${input.licenseKey} AND app_key = ${input.appKey} AND store_id = ${input.storeId}
    LIMIT 1 FOR UPDATE
  `);
  const row = (res as unknown as { rows: Array<{ id: string; status: string; seats: number; expires_at: Date | string | null; app_key: string; metadata: unknown; created_at: Date | string }> }).rows[0];
  if (!row || row.status !== 'active') return null;
  const expiresAt = row.expires_at != null ? new Date(row.expires_at) : null;
  if (expiresAt != null && expiresAt.getTime() <= Date.now()) return null;
  return { id: row.id, status: row.status, seats: row.seats, expiresAt, appKey: row.app_key, metadata: row.metadata, createdAt: new Date(row.created_at) };
}

export type IssueLeaseResult =
  | { kind: 'notfound' }
  | { kind: 'rejected_platform'; reason: string }
  | { kind: 'full' }
  | { kind: 'ok'; lease: LeaseEnvelope; activationId: string; activationToken: string };

/** Issue (or idempotently re-issue for the same device) a device lease.
 *  Serializes on the license row (FOR UPDATE), same pattern as
 *  activateLicenseOnDevice — a concurrent issue for the SAME license
 *  therefore cannot race past the pool-cap check (closes the "concurrent
 *  activation racing seat exhaustion" abuse case). */
export async function issueDeviceLease(
  tx: Tx,
  input: {
    storeId: string; appKey: string; licenseKey: string;
    deviceIdHash: string; platform: Platform; deviceLabel?: string | null;
  },
): Promise<IssueLeaseResult> {
  // Pool is derived server-side from the platform, never accepted from the
  // client. Platforms that land in a non-leasable pool (companion devices —
  // they receive entitlement from a paired device, never hold a lease of their
  // own) are rejected at the derivation level, so NO platform value can ever
  // claim an uncapped pool: every accepted platform costs a seat.
  // derivePool consults the generic platform taxonomy plus the app's
  // platformPools overrides; null = a platform this app does not know.
  const pool = derivePool(input.appKey, input.platform);
  if (!pool) return { kind: 'rejected_platform', reason: `unknown platform "${input.platform}"` };
  if (!leasablePool(input.appKey, pool)) {
    return { kind: 'rejected_platform', reason: `platform "${input.platform}" resolves to a companion pool — companion devices do not activate a license directly` };
  }

  const lic = await lockActiveLicense(tx, input);
  if (!lic) return { kind: 'notfound' };

  // Only unmarked legacy seats<=0 licenses are grandfathered unlimited.
  // Policy-marked seats=0 licenses use bounded pool caps instead of the flat
  // seat count. With no registered policy the flat seat count is authoritative.
  const policy = devicePolicyFor(lic.appKey);
  const unlimited = lic.seats <= 0 && !usesBoundedDevicePools(lic.appKey, lic.seats, lic.metadata);

  const existing = await tx
    .select({ id: s.licenseActivation.id, deviceIdHash: s.licenseActivation.deviceIdHash, pool: s.licenseActivation.pool, generation: s.licenseActivation.generation })
    .from(s.licenseActivation)
    .where(and(eq(s.licenseActivation.licenseId, lic.id), eq(s.licenseActivation.state, 'active')));

  const sameDevice = existing.find((r) => r.deviceIdHash === input.deviceIdHash);
  if (!sameDevice && !unlimited) {
    const cap = policy ? poolCap(lic.appKey, pool) : lic.seats;
    const inScope = policy ? existing.filter((r) => r.pool === pool) : existing;
    if (inScope.length >= cap) return { kind: 'full' };
  }

  const activationToken = newActivationToken();
  const activationTokenHash = hashActivationToken(activationToken);
  const now = new Date();
  const leaseId = randomUUID();
  const issuedAt = now;
  const ttlSeconds = leaseTtlSecondsFor(lic.appKey);
  const graceSeconds = leaseGraceSecondsFor(lic.appKey);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const generation = sameDevice?.generation ?? 0;

  let activationId: string;
  if (sameDevice) {
    activationId = sameDevice.id;
    await tx.update(s.licenseActivation).set({
      activationTokenHash,
      platform: input.platform,
      pool,
      deviceClass: legacyDeviceClassFor(input.platform),
      deviceLabel: input.deviceLabel ?? undefined,
      state: 'active',
      leaseId,
      leaseIssuedAt: issuedAt,
      leaseExpiresAt: expiresAt,
      leaseGraceSeconds: graceSeconds,
      lastSeenAt: now,
      updatedAt: now,
    }).where(eq(s.licenseActivation.id, sameDevice.id));
  } else {
    // Reactivating a device that was previously tombstoned (removed/revoked)
    // on THIS license reuses the row (unique(licenseId, deviceIdHash) would
    // otherwise conflict on insert) — this is the idempotent-reactivation
    // path, and generation is preserved rather than reset, so a stale client
    // still holding an old (now-superseded) lease/token cannot be confused
    // with a legitimately re-admitted device.
    const [tombstoned] = await tx
      .select({ id: s.licenseActivation.id, generation: s.licenseActivation.generation })
      .from(s.licenseActivation)
      .where(and(eq(s.licenseActivation.licenseId, lic.id), eq(s.licenseActivation.deviceIdHash, input.deviceIdHash)))
      .limit(1);
    if (tombstoned) {
      activationId = tombstoned.id;
      await tx.update(s.licenseActivation).set({
        activationTokenHash,
        platform: input.platform,
        pool,
        deviceClass: legacyDeviceClassFor(input.platform),
        deviceLabel: input.deviceLabel ?? null,
        state: 'active',
        leaseId,
        leaseIssuedAt: issuedAt,
        leaseExpiresAt: expiresAt,
        leaseGraceSeconds: graceSeconds,
        removedAt: null,
        lastSeenAt: now,
        updatedAt: now,
      }).where(eq(s.licenseActivation.id, tombstoned.id));
    } else {
      const [created] = await tx.insert(s.licenseActivation).values({
        storeId: input.storeId,
        licenseId: lic.id,
        appKey: input.appKey,
        deviceIdHash: input.deviceIdHash,
        activationTokenHash,
        deviceLabel: input.deviceLabel ?? null,
        platform: input.platform,
        pool,
        deviceClass: legacyDeviceClassFor(input.platform),
        state: 'active',
        leaseId,
        leaseIssuedAt: issuedAt,
        leaseExpiresAt: expiresAt,
        leaseGraceSeconds: graceSeconds,
      }).returning({ id: s.licenseActivation.id });
      if (!created) throw new Error('device lease activation insert returned no id');
      activationId = created.id;
    }
  }

  const entitlements = buildEntitlements({ appKey: input.appKey, metadata: lic.metadata });
  const entitlement = entitlements.tier
    ? signEntitlement({
      licenseId: lic.id, app: input.appKey, tier: entitlements.tier, features: entitlements.features,
      deviceId: input.deviceIdHash, expiresAtUnix: lic.expiresAt ? Math.floor(lic.expiresAt.getTime() / 1000) : null,
    }, now.getTime())
    : null;

  const envelopeCore = {
    leaseId, deviceIdHash: input.deviceIdHash, pool,
    issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(),
    graceSeconds, generation,
  };
  const signature = signLeaseEnvelope(canonicalLeaseEnvelope(envelopeCore));

  return {
    kind: 'ok',
    activationId,
    activationToken,
    lease: { ...envelopeCore, entitlement, signature },
  };
}

export type RenewLeaseResult =
  | { kind: 'notfound' }
  | { kind: 'revoked' }
  | { kind: 'ok'; lease: LeaseEnvelope };

/** Renew an existing lease. Token rotation + replay rejection: the caller must
 *  present the CURRENT leaseId — renewing mints a NEW leaseId, so a captured
 *  old leaseId is immediately unusable for a second renew.
 *
 *  The activation row is locked FOR UPDATE before the leaseId check so two
 *  concurrent renews of the same leaseId serialize (check-then-rotate is
 *  atomic): exactly one wins and the loser sees the rotated leaseId. */
export async function renewDeviceLease(
  tx: Tx,
  input: { storeId: string; appKey: string; deviceIdHash: string; leaseId: string },
): Promise<RenewLeaseResult> {
  const rows = await tx
    .select({
      id: s.licenseActivation.id, licenseId: s.licenseActivation.licenseId, state: s.licenseActivation.state,
      pool: s.licenseActivation.pool, generation: s.licenseActivation.generation, leaseId: s.licenseActivation.leaseId,
    })
    .from(s.licenseActivation)
    .where(and(
      eq(s.licenseActivation.storeId, input.storeId),
      eq(s.licenseActivation.appKey, input.appKey),
      eq(s.licenseActivation.deviceIdHash, input.deviceIdHash),
    ))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (!row) return { kind: 'notfound' };
  if (row.state !== 'active') return { kind: 'revoked' };
  // Replay rejection: the presented leaseId must match the currently-issued one.
  if (row.leaseId !== input.leaseId) return { kind: 'notfound' };

  const lic = await tx.select({ status: s.license.status, expiresAt: s.license.expiresAt, appKey: s.license.appKey, metadata: s.license.metadata, id: s.license.id })
    .from(s.license).where(eq(s.license.id, row.licenseId)).limit(1);
  const licRow = lic[0];
  if (!licRow || licRow.status !== 'active' || (licRow.expiresAt != null && licRow.expiresAt.getTime() <= Date.now())) {
    return { kind: 'revoked' };
  }

  const now = new Date();
  const newLeaseId = randomUUID();
  const expiresAt = new Date(now.getTime() + leaseTtlSecondsFor(licRow.appKey) * 1000);
  const graceSeconds = leaseGraceSecondsFor(licRow.appKey);
  await tx.update(s.licenseActivation).set({
    leaseId: newLeaseId, leaseIssuedAt: now, leaseExpiresAt: expiresAt, leaseGraceSeconds: graceSeconds,
    lastSeenAt: now, updatedAt: now,
  }).where(eq(s.licenseActivation.id, row.id));

  const entitlements = buildEntitlements({ appKey: licRow.appKey, metadata: licRow.metadata });
  const entitlement = entitlements.tier
    ? signEntitlement({
      licenseId: licRow.id, app: licRow.appKey, tier: entitlements.tier, features: entitlements.features,
      deviceId: input.deviceIdHash, expiresAtUnix: licRow.expiresAt ? Math.floor(licRow.expiresAt.getTime() / 1000) : null,
    }, now.getTime())
    : null;

  const envelopeCore = {
    leaseId: newLeaseId, deviceIdHash: input.deviceIdHash, pool: row.pool as Pool,
    issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
    graceSeconds, generation: row.generation,
  };
  const signature = signLeaseEnvelope(canonicalLeaseEnvelope(envelopeCore));
  return { kind: 'ok', lease: { ...envelopeCore, entitlement, signature } };
}

/** Remote removal. Keeps a tombstone row (state='revoked'), bumps `generation`
 *  (invalidates any outstanding lease/replay for the device), and frees the
 *  pool slot transactionally (the state filter on the counting query above
 *  means the freed row no longer counts). Idempotent: removing an
 *  already-revoked/unknown device is a no-op success. */
export async function revokeDeviceRemote(
  tx: Tx,
  input: { storeId: string; licenseId: string; activationId: string },
): Promise<{ kind: 'ok' } | { kind: 'notfound' }> {
  const now = new Date();
  const result = await tx.update(s.licenseActivation)
    .set({ state: 'revoked', revokedAt: now, updatedAt: now, generation: sql`${s.licenseActivation.generation} + 1` })
    .where(and(
      eq(s.licenseActivation.id, input.activationId),
      eq(s.licenseActivation.storeId, input.storeId),
      eq(s.licenseActivation.licenseId, input.licenseId),
    ))
    .returning({ id: s.licenseActivation.id });
  if (!result.length) return { kind: 'notfound' };
  return { kind: 'ok' };
}

/** Offline local removal — the device itself is asking to give up its seat.
 *  The exact lease id makes delayed retries generation-safe: an old queued
 *  removal can never revoke a later reactivation of the same device. */
export async function removeDeviceOffline(
  tx: Tx,
  input: { storeId: string; appKey: string; deviceIdHash: string; leaseId: string },
): Promise<{ kind: 'ok' }> {
  const now = new Date();
  await tx.update(s.licenseActivation)
    .set({ state: 'removed', removedAt: now, updatedAt: now, generation: sql`${s.licenseActivation.generation} + 1` })
    .where(and(
      eq(s.licenseActivation.storeId, input.storeId),
      eq(s.licenseActivation.appKey, input.appKey),
      eq(s.licenseActivation.deviceIdHash, input.deviceIdHash),
      eq(s.licenseActivation.leaseId, input.leaseId),
      eq(s.licenseActivation.state, 'active'),
    ));
  return { kind: 'ok' };
}

export { hashDeviceId, canonicalLeaseEnvelope };
