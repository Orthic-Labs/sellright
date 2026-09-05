import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashActivationToken, newActivationToken } from './tokens.js';

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
};

export async function activateLicenseOnDevice(
  tx: Tx,
  input: {
    storeId: string;
    appKey: string;
    licenseKey: string;
    deviceId: string;
    deviceLabel?: string | null;
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
    SELECT id, status, seats, expires_at, updates_until, app_key, license_key, store_id
    FROM license
    WHERE store_id    = ${input.storeId}
      AND license_key = ${input.licenseKey}
      AND app_key     = ${input.appKey}
    LIMIT 1
    FOR UPDATE
  `);
  const rawLic = (licResult as unknown as { rows: LicRow[] }).rows[0];
  if (!rawLic || rawLic.status !== 'active') return { kind: 'notfound' as const };

  // ra-009: Also reject if the license has a hard expiry in the past.
  const expiresAt = rawLic.expires_at != null ? new Date(rawLic.expires_at) : null;
  if (expiresAt != null && expiresAt.getTime() < Date.now()) {
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
  };

  const deviceIdHash = hashDeviceId(input.deviceId);
  const activationToken = newActivationToken();
  const activationTokenHash = hashActivationToken(activationToken);

  const existing = await tx
    .select({ id: s.licenseActivation.id })
    .from(s.licenseActivation)
    .where(eq(s.licenseActivation.licenseId, lic.id));

  const [sameDevice] = await tx
    .select({ id: s.licenseActivation.id })
    .from(s.licenseActivation)
    .where(and(eq(s.licenseActivation.licenseId, lic.id), eq(s.licenseActivation.deviceIdHash, deviceIdHash)))
    .limit(1);

  // seats <= 0 means UNLIMITED devices (no device cap by policy; the license date is
  // the only limit). A positive seats value still enforces the per-license device cap.
  const unlimited = lic.seats <= 0;
  if (!unlimited && !sameDevice && existing.length >= lic.seats) return { kind: 'full' as const };

  if (sameDevice) {
    await tx
      .update(s.licenseActivation)
      .set({ activationTokenHash, lastSeenAt: new Date(), deviceLabel: input.deviceLabel ?? null })
      .where(eq(s.licenseActivation.id, sameDevice.id));
  } else {
    await tx.insert(s.licenseActivation).values({
      storeId: input.storeId,
      licenseId: lic.id,
      appKey: input.appKey,
      deviceIdHash,
      activationTokenHash,
      deviceLabel: input.deviceLabel ?? null,
    });
  }

  return { kind: 'ok' as const, lic, activationToken };
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
      eq(s.license.appKey, input.appKey),
    ))
    .limit(1);

  if (!row || row.license.status !== 'active') return null;

  // ra-009: Reject tokens whose license has passed its hard expiry date.
  if (row.license.expiresAt != null && new Date(row.license.expiresAt).getTime() < Date.now()) {
    return null;
  }

  if (input.deviceId && row.deviceIdHash !== hashDeviceId(input.deviceId)) return null;

  await tx
    .update(s.licenseActivation)
    .set({ lastSeenAt: new Date() })
    .where(eq(s.licenseActivation.id, row.activationId));

  return row;
}
