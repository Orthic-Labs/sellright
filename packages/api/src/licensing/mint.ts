import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { newLicenseKey } from './issue.js';
import { devicePolicyFor, withCurrentDevicePolicy } from './device-policy.js';

/**
 * Issue a license OUTSIDE the order pipeline — creator/comp/support keys.
 * orderId/orderLineId are null and source='admin' so reporting can exclude
 * non-revenue entitlements.
 *
 * Orderless issuance REQUIRES explicit provenance (audit requirement): the
 * caller must name the authorizing actor (`issuedBy`, e.g. the admin email)
 * and a human-readable `reason`. Both persist on the license row, and route
 * callers additionally record the mint in audit_log.
 *
 * The caller controls seats + term explicitly:
 *   updatesUntil = null  -> lifetime updates
 *   expiresAt    = null  -> perpetual (no hard expiry)
 * For apps with a pooled-seats device policy, seats is forced to 0 and the
 * policy marker is stamped into metadata so pool caps are authoritative.
 */
export async function mintLicense(
  tx: Tx,
  input: {
    storeId: string;
    appKey: string;
    seats: number;
    updatesUntil: Date | null;
    expiresAt: Date | null;
    customerId?: string | null;
    licenseKey?: string;
    metadata?: unknown;
    /** Authorizing actor identity (admin email / service id). Required. */
    issuedBy: string;
    /** Why this license exists (ticket, comp reason, promotion). Required. */
    reason: string;
  },
): Promise<{ licenseId: string; licenseKey: string }> {
  if (!input.issuedBy?.trim() || !input.reason?.trim()) {
    throw new Error('orderless license issuance requires explicit provenance (issuedBy + reason)');
  }
  const policy = devicePolicyFor(input.appKey);
  const licenseKey = input.licenseKey ?? newLicenseKey(input.appKey);
  const [row] = await tx
    .insert(s.license)
    .values({
      storeId: input.storeId,
      customerId: input.customerId ?? null,
      orderId: null,
      orderLineId: null,
      source: 'admin',
      issuedBy: input.issuedBy,
      issueReason: input.reason,
      appKey: input.appKey,
      licenseKey,
      seats: policy?.pooledSeats ? 0 : input.seats,
      updatesUntil: input.updatesUntil,
      expiresAt: input.expiresAt,
      metadata: (withCurrentDevicePolicy(input.appKey, input.metadata) as object | null) ?? null,
    })
    .returning({ id: s.license.id });
  return { licenseId: row!.id, licenseKey };
}
