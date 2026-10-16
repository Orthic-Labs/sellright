// License lifecycle service (de-fork Phase 5): server-authority revoke and restore.
// Revoke flips `license.status` to 'revoked' and cascades to every active
// activation (device seat / lease) of that license: each becomes a tombstone
// (`state='revoked'`, generation bumped) so stale leases fail the renew path.
// Restore flips the license back to 'active' only; cascaded activations are NOT
// reactivated (the device must activate again and take a fresh seat). Restore
// never resurrects a licence past its hard expiry. Both run in one store-scoped
// transaction with the license row locked FOR UPDATE.
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';

export const LICENSE_REVOCATION_PERMISSION = 'license_revocation';

export type LicenseRevokeOutcome =
  | { kind: 'ok'; licenseId: string; status: 'revoked'; changed: boolean; revokedActivationIds: string[] }
  | { kind: 'notfound' };

export type LicenseRestoreOutcome =
  | { kind: 'ok'; licenseId: string; status: 'active'; changed: boolean }
  | { kind: 'notfound' }
  | { kind: 'refused'; reason: 'expired' };

export interface LicenseLifecycleActor {
  actor: string | null;
  reason?: string | null;
  now?: Date;
}

async function lockLicense(tx: Tx, storeId: string, licenseId: string) {
  const [row] = await tx.select({
    id: s.license.id,
    status: s.license.status,
    expiresAt: s.license.expiresAt,
  }).from(s.license)
    .where(and(eq(s.license.id, licenseId), eq(s.license.storeId, storeId)))
    .for('update');
  return row ?? null;
}

/** Revoke a license and cascade to its active activations. Idempotent: a license
 *  that is already revoked returns `changed: false` with no further mutation. */
export async function revokeLicenseInTx(
  tx: Tx,
  storeId: string,
  licenseId: string,
  who: LicenseLifecycleActor,
): Promise<LicenseRevokeOutcome> {
  const now = who.now ?? new Date();
  const lic = await lockLicense(tx, storeId, licenseId);
  if (!lic) return { kind: 'notfound' };
  if (lic.status === 'revoked') {
    return { kind: 'ok', licenseId, status: 'revoked', changed: false, revokedActivationIds: [] };
  }
  await tx.update(s.license)
    .set({ status: 'revoked', updatedAt: now })
    .where(and(eq(s.license.id, licenseId), eq(s.license.storeId, storeId)));
  // Cascade: every active seat/lease of this license becomes a tombstone.
  const revoked = await tx.update(s.licenseActivation)
    .set({
      state: 'revoked',
      revokedAt: now,
      updatedAt: now,
      generation: sql`${s.licenseActivation.generation} + 1`,
    })
    .where(and(
      eq(s.licenseActivation.storeId, storeId),
      eq(s.licenseActivation.licenseId, licenseId),
      eq(s.licenseActivation.state, 'active'),
    ))
    .returning({ id: s.licenseActivation.id });
  await tx.insert(s.auditLog).values({
    storeId,
    actor: who.actor,
    entity: 'license',
    entityId: licenseId,
    action: 'revoke',
    fromState: lic.status,
    toState: 'revoked',
    data: { reason: who.reason ?? null, revokedActivations: revoked.length },
    at: now,
  });
  return { kind: 'ok', licenseId, status: 'revoked', changed: true, revokedActivationIds: revoked.map((r) => r.id) };
}

/** Restore a revoked license to active. Refused when the hard expiry has passed.
 *  Cascaded activations stay revoked. Restoring an active license is a no-op. */
export async function restoreLicenseInTx(
  tx: Tx,
  storeId: string,
  licenseId: string,
  who: LicenseLifecycleActor,
): Promise<LicenseRestoreOutcome> {
  const now = who.now ?? new Date();
  const lic = await lockLicense(tx, storeId, licenseId);
  if (!lic) return { kind: 'notfound' };
  if (lic.status === 'active') return { kind: 'ok', licenseId, status: 'active', changed: false };
  if (lic.expiresAt != null && lic.expiresAt.getTime() <= now.getTime()) return { kind: 'refused', reason: 'expired' };
  await tx.update(s.license)
    .set({ status: 'active', updatedAt: now })
    .where(and(eq(s.license.id, licenseId), eq(s.license.storeId, storeId)));
  await tx.insert(s.auditLog).values({
    storeId,
    actor: who.actor,
    entity: 'license',
    entityId: licenseId,
    action: 'restore',
    fromState: lic.status,
    toState: 'active',
    data: { reason: who.reason ?? null },
    at: now,
  });
  return { kind: 'ok', licenseId, status: 'active', changed: true };
}

/** Store-scoped convenience wrappers (open their own transaction). */
export const licenseLifecycle = {
  revoke: (storeId: string, licenseId: string, who: LicenseLifecycleActor) =>
    withStore(storeId, (tx) => revokeLicenseInTx(tx, storeId, licenseId, who)),
  restore: (storeId: string, licenseId: string, who: LicenseLifecycleActor) =>
    withStore(storeId, (tx) => restoreLicenseInTx(tx, storeId, licenseId, who)),
};
