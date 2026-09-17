import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashActivationToken, newActivationToken } from './tokens.js';
import { activationSourceDefaults, devicePolicyFor, poolCap, usesBoundedDevicePools, type ActivationPool } from './device-policy.js';

// cs-7: not exported — only used internally within this module.
function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

// Shape returned by the FOR UPDATE raw query; column names are snake_case as
// Postgres returns them. We normalize to camelCase before returning to callers.
type LicRow = {
  id: string;
  status: string;
  seats: number;
  expires_at: Date | string | null;
  updates_until: Date | string | null;
  app_key: string;
  license_key: string;
  store_id: string;
  metadata: unknown;
  created_at: Date | string;
};

/**
 * Derive stored class+pool from a trusted server-side route/proof. `pool` is
 * NEVER client-supplied: the caller passes only an `activationSource`
 * describing which trusted path the request arrived through, and the app's
 * registered device policy maps it to a pool. Returns null for apps with no
 * registered policy — their rows stay unclassified and flat-seat semantics
 * apply unchanged.
 */
export function deriveDeviceClassAndPool(
  appKey: string,
  source: string,
): { deviceClass: string; pool: ActivationPool } | null {
  return activationSourceDefaults(appKey, source);
}

/** Interpret the stored pool of a pre-existing activation row. `pool` is
 *  authoritative on new rows; older rows only have `deviceClass`, so map the
 *  legacy class vocabulary onto pools for cap accounting. */
function storedPool(row: { pool: string | null; deviceClass: string | null }): ActivationPool | null {
  if (row.pool) return row.pool;
  // Pre-pool rows: preserve their old cap accounting. The legacy class names
  // below are the historical storage vocabulary, not policy.
  if (row.deviceClass === 'mac' || row.deviceClass === 'windows' || row.deviceClass === 'desktop') return 'computer';
  if (row.deviceClass === 'iphone' || row.deviceClass === 'android') return 'mobile';
  return null;
}

export async function activateLicenseOnDevice(
  tx: Tx,
  input: {
    storeId: string;
    appKey: string;
    licenseKey: string;
    deviceId: string;
    deviceLabel?: string | null;
    /** @deprecated Ignored; pool is derived from activationSource, never from a client claim. */
    deviceClass?: string | null;
    /** Trusted route/proof classification supplied by the server, never raw HTTP input. */
    activationSource?: string;
  },
) {
  // ra-001: Re-select the license row FOR UPDATE inside the transaction so that
  // concurrent activations on the same license serialize rather than racing past
  // the seat-cap check. The unique(licenseId, deviceIdHash) index still handles
  // same-device re-activation idempotently even if two requests arrive for the
  // same device at the same time.
  //
  // Tenant ownership must be explicit here. This raw lock query is a security
  // boundary, not merely a lookup: a license key/app pair from another store must
  // never be activatable from the current store context even if database/RLS
  // configuration is incomplete or accidentally bypassed in a test/admin path.
  const licResult = await tx.execute(sql`
    SELECT id, status, seats, expires_at, updates_until, app_key, license_key, store_id, metadata, created_at
    FROM license
    WHERE store_id    = ${input.storeId}
      AND license_key = ${input.licenseKey}
      AND app_key     = ${input.appKey}
    LIMIT 1
    FOR UPDATE
  `);
  const rawLic = (licResult as unknown as { rows: LicRow[] }).rows[0];
  if (!rawLic || rawLic.status !== 'active') return { kind: 'notfound' as const };

  // ra-009: Also reject if the license has a hard expiry in the past (second
  // precision — a license expiring within the current second is already out).
  const expiresAt = rawLic.expires_at != null ? new Date(rawLic.expires_at) : null;
  if (expiresAt != null && Math.floor(expiresAt.getTime() / 1000) <= Math.floor(Date.now() / 1000)) {
    return { kind: 'notfound' as const };
  }

  // Normalize raw row to the camelCase shape that callers (apps.ts) expect.
  const lic = {
    id: rawLic.id,
    status: rawLic.status,
    seats: rawLic.seats,
    expiresAt,
    updatesUntil: rawLic.updates_until != null ? new Date(rawLic.updates_until) : null,
    appKey: rawLic.app_key,
    licenseKey: rawLic.license_key,
    storeId: rawLic.store_id,
    metadata: rawLic.metadata,
    createdAt: new Date(rawLic.created_at),
  };

  const deviceIdHash = hashDeviceId(input.deviceId);
  const activationToken = newActivationToken();
  const activationTokenHash = hashActivationToken(activationToken);

  const existing = await tx
    .select({ id: s.licenseActivation.id, deviceClass: s.licenseActivation.deviceClass, pool: s.licenseActivation.pool, state: s.licenseActivation.state })
    .from(s.licenseActivation)
    .where(eq(s.licenseActivation.licenseId, lic.id));
  // Tombstoned rows (state 'removed'/'revoked') keep their device_id_hash but
  // do NOT consume a seat — the cap counts only live activations.
  const activeExisting = existing.filter((row) => row.state === 'active');

  const [sameDevice] = await tx
    .select({ id: s.licenseActivation.id })
    .from(s.licenseActivation)
    .where(and(eq(s.licenseActivation.licenseId, lic.id), eq(s.licenseActivation.deviceIdHash, deviceIdHash)))
    .limit(1);

  // seats <= 0 means UNLIMITED devices (no flat device cap by policy; the license date
  // is the only limit). A positive seats value still enforces the per-license device cap.
  const unlimited = lic.seats <= 0;
  if (!unlimited && !sameDevice && activeExisting.length >= lic.seats) return { kind: 'full' as const };

  // Bounded device pools (registered per-app device policy). The route/proof
  // source, not request deviceClass, picks the pool.
  const bounded = usesBoundedDevicePools(input.appKey, lic.seats, lic.metadata);
  const derived = devicePolicyFor(input.appKey)
    ? deriveDeviceClassAndPool(input.appKey, input.activationSource ?? 'desktop')
    : null;
  const deviceClass: string | null = derived?.deviceClass ?? null;
  const pool: ActivationPool | null = derived?.pool ?? null;
  if (bounded && pool) {
    const sameDevicePool = sameDevice
      ? storedPool(existing.find((row) => row.id === sameDevice.id) ?? { pool: null, deviceClass: null })
      : null;
    const movingPool = sameDevicePool !== pool;
    if ((!sameDevice || movingPool)
      && activeExisting.filter((row) => row.id !== sameDevice?.id && storedPool(row) === pool).length >= poolCap(input.appKey, pool)) {
      return { kind: 'full' as const };
    }
  }

  let activationId: string;
  if (sameDevice) {
    activationId = sameDevice.id;
    await tx
      .update(s.licenseActivation)
      .set({
        activationTokenHash,
        lastSeenAt: new Date(),
        deviceLabel: input.deviceLabel ?? null,
        ...(deviceClass ? { deviceClass } : {}),
        ...(pool ? { pool } : {}),
        // Re-activation clears any tombstone.
        state: 'active',
        revokedAt: null,
        removedAt: null,
      })
      .where(eq(s.licenseActivation.id, sameDevice.id));
  } else {
    const [created] = await tx.insert(s.licenseActivation).values({
      storeId: input.storeId,
      licenseId: lic.id,
      appKey: input.appKey,
      deviceIdHash,
      activationTokenHash,
      deviceLabel: input.deviceLabel ?? null,
      deviceClass,
      pool,
    }).returning({ id: s.licenseActivation.id });
    if (!created) throw new Error('license activation insert returned no id');
    activationId = created.id;
  }

  return { kind: 'ok' as const, lic, activationId, activationToken };
}

export async function findActivationByToken(
  tx: Tx,
  input: {
    appKey: string;
    activationToken: string;
    deviceId?: string | null;
  },
) {
  const activationTokenHash = hashActivationToken(input.activationToken);
  const [row] = await tx
    .select({
      activationId: s.licenseActivation.id,
      deviceIdHash: s.licenseActivation.deviceIdHash,
      license: s.license,
    })
    .from(s.licenseActivation)
    .innerJoin(s.license, eq(s.license.id, s.licenseActivation.licenseId))
    .where(and(
      eq(s.licenseActivation.activationTokenHash, activationTokenHash),
      eq(s.licenseActivation.appKey, input.appKey),
      // Tombstoned activations keep their token hash; a revoked/removed
      // device must not resolve. (Fix vs the original port source, which
      // matched tombstoned rows.)
      eq(s.licenseActivation.state, 'active'),
      eq(s.license.appKey, input.appKey),
    ))
    .limit(1);

  if (!row || row.license.status !== 'active') return null;

  // ra-009: Reject tokens whose license has passed its hard expiry date.
  if (row.license.expiresAt != null
    && Math.floor(new Date(row.license.expiresAt).getTime() / 1000) <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  if (input.deviceId && row.deviceIdHash !== hashDeviceId(input.deviceId)) return null;

  await tx
    .update(s.licenseActivation)
    .set({ lastSeenAt: new Date() })
    .where(eq(s.licenseActivation.id, row.activationId));

  return row;
}

/** Free a device seat. Idempotent: an unknown/already-removed token is a no-op
 *  that still returns ok, so the client can clear local state unconditionally. */
export async function deactivateDevice(
  tx: Tx,
  input: { appKey: string; activationToken: string },
): Promise<{ kind: 'ok' }> {
  const activationTokenHash = hashActivationToken(input.activationToken);
  await tx
    .delete(s.licenseActivation)
    .where(and(
      eq(s.licenseActivation.activationTokenHash, activationTokenHash),
      eq(s.licenseActivation.appKey, input.appKey),
    ));
  return { kind: 'ok' as const };
}

export type EntitlementIssuanceInventory = {
  canonicalV2: number;
  legacyOrUnknown: number;
  canRemoveLegacyVerifier: boolean;
};

/** Mark a token as canonically issued only after the signer has returned it.
 * The caller must await this inside withStore before returning the token.
 *
 * The license row is locked and rechecked first. This is the refund/revocation
 * linearization point: a concurrent revoke either completes first and prevents
 * issuance, or waits until this valid issuance transaction commits. */
export async function recordCanonicalEntitlementIssuance(
  tx: Tx,
  input: { activationId: string; appKey: string },
): Promise<boolean> {
  const locked = await tx.execute(sql`
    SELECT activation.id
    FROM license_activation AS activation
    INNER JOIN license
      ON license.id = activation.license_id
      AND license.app_key = activation.app_key
    WHERE activation.id = ${input.activationId}
      AND activation.app_key = ${input.appKey}
      AND activation.state = 'active'
      AND license.status = 'active'::license_status
      AND (license.expires_at IS NULL OR license.expires_at > NOW())
    FOR UPDATE OF license, activation
  `);
  if ((locked as unknown as { rows: unknown[] }).rows.length !== 1) return false;

  const result = await tx.execute(sql`
    UPDATE license_activation
    SET entitlement_token_version = 2,
        entitlement_token_issued_at = NOW()
    WHERE id = ${input.activationId}
      AND app_key = ${input.appKey}
    RETURNING id
  `);
  if ((result as unknown as { rows: unknown[] }).rows.length !== 1) {
    throw new Error('canonical entitlement issuance was not recorded');
  }
  return true;
}

/** Store-scoped removal gate. The caller must supply a transaction created by
 * withStore so FORCE RLS applies to both activation and license rows. */
export async function getEntitlementIssuanceInventory(
  tx: Tx,
  input: { appKey?: string },
): Promise<EntitlementIssuanceInventory> {
  const appFilter = input.appKey
    ? sql`AND activation.app_key = ${input.appKey}`
    : sql``;
  const result = await tx.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE activation.entitlement_token_version = 2
          AND activation.entitlement_token_issued_at IS NOT NULL
      )::integer AS canonical_v2,
      COUNT(*) FILTER (
        WHERE activation.entitlement_token_version IS DISTINCT FROM 2
          OR activation.entitlement_token_issued_at IS NULL
      )::integer AS legacy_or_unknown
    FROM license_activation AS activation
    INNER JOIN license
      ON license.id = activation.license_id
      AND license.app_key = activation.app_key
    WHERE license.status = 'active'::license_status
      AND (license.expires_at IS NULL OR license.expires_at > NOW())
      ${appFilter}
  `);
  const row = (result as unknown as {
    rows: Array<{ canonical_v2: number | string; legacy_or_unknown: number | string }>;
  }).rows[0];
  const canonicalV2 = Number(row?.canonical_v2 ?? 0);
  const legacyOrUnknown = Number(row?.legacy_or_unknown ?? 0);
  return {
    canonicalV2,
    legacyOrUnknown,
    canRemoveLegacyVerifier: legacyOrUnknown === 0,
  };
}
