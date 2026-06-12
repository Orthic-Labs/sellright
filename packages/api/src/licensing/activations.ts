import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashActivationToken, newActivationToken } from './tokens.js';

export function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

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
  const [lic] = await tx
    .select()
    .from(s.license)
    .where(and(eq(s.license.licenseKey, input.licenseKey), eq(s.license.appKey, input.appKey)))
    .limit(1);
  if (!lic || lic.status !== 'active') return { kind: 'notfound' as const };

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

  if (!sameDevice && existing.length >= lic.seats) return { kind: 'full' as const };

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
  if (input.deviceId && row.deviceIdHash !== hashDeviceId(input.deviceId)) return null;

  await tx
    .update(s.licenseActivation)
    .set({ lastSeenAt: new Date() })
    .where(eq(s.licenseActivation.id, row.activationId));

  return row;
}
