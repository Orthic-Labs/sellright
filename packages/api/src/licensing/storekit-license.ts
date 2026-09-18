// StoreKit purchase → license binding. Ported upstream from RightSites'
// licensing/storekit-license.ts, genericized: the entitlement shape comes
// from the configured product map (storekit_app.product_map), and the
// durable binding lives in the `storekit_purchase` table rather than only
// in license metadata.
import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import type { StoreKitProductEntitlement } from './storekit-config.js';
import { hashActivationToken, newActivationToken } from './tokens.js';

export interface VerifiedStoreKitLicenseSource {
  originalTransactionId: string;
  transactionId?: string | null;
  bundleId: string;
  environment: string;
  productId?: string | null;
  /** Signed purchase + expiry times (ms epoch), when the JWS carries them. */
  purchaseDate?: number | null;
  expiresDate?: number | null;
}

export function storeKitLicenseKey(appKey: string, source: VerifiedStoreKitLicenseSource): string {
  // Sandbox & Production transaction namespaces must never collide. Apple
  // does not promise originalTransactionId uniqueness across environments.
  const digest = createHash('sha256')
    .update(`${appKey}:${source.environment}:${source.originalTransactionId}`)
    .digest('hex')
    .toUpperCase()
    .slice(0, 32);
  return `SK-${digest}`;
}

export type EnsureStoreKitLicenseResult =
  | { kind: 'ok'; id: string; licenseKey: string }
  | { kind: 'account_conflict' };

function addDays(d: Date, days: number | null | undefined): Date | null {
  if (days == null) return null;
  return new Date(d.getTime() + days * 86_400_000);
}

/** Idempotently materialize one internal license + one storekit_purchase row
 *  per verified StoreKit purchase/environment. Optional customer linking is
 *  serialized through a conditional update, so concurrent requests cannot
 *  attach one purchase to two accounts.
 *
 *  `entitlement` comes from the app's configured product map — it decides
 *  seats/expiry/metadata tier for the minted license and is NEVER derived
 *  from request input (the verified productId selects the map entry). */
export async function ensureStoreKitLicense(
  tx: Tx,
  input: {
    storeId: string;
    storekitAppId?: string | null;
    appKey: string;
    source: VerifiedStoreKitLicenseSource;
    entitlement?: StoreKitProductEntitlement | null;
    customerId?: string | null;
  },
): Promise<EnsureStoreKitLicenseResult> {
  const licenseKey = storeKitLicenseKey(input.appKey, input.source);
  const now = new Date();
  const ent = input.entitlement ?? {};
  const expiresAt = input.source.expiresDate != null
    ? new Date(input.source.expiresDate)
    : addDays(now, ent.licenseDurationDays);
  const updatesUntil = ent.updatesDurationDays != null
    ? addDays(now, ent.updatesDurationDays)
    : expiresAt;

  await tx.insert(s.license).values({
    storeId: input.storeId,
    customerId: input.customerId ?? null,
    orderId: null,
    orderLineId: null,
    appKey: input.appKey,
    licenseKey,
    status: 'active',
    source: 'storekit',
    seats: ent.seats ?? 0,
    expiresAt,
    updatesUntil,
    metadata: {
      tier: ent.tier ?? 'pro',
      storekit_original_transaction_id: input.source.originalTransactionId,
      storekit_bundle_id: input.source.bundleId,
      storekit_environment: input.source.environment,
      storekit_product_id: input.source.productId ?? null,
    },
  }).onConflictDoNothing();

  let [lic] = await tx.select({ id: s.license.id, customerId: s.license.customerId })
    .from(s.license)
    .where(and(eq(s.license.licenseKey, licenseKey), eq(s.license.appKey, input.appKey)))
    .limit(1);
  if (!lic) throw new Error('StoreKit license upsert returned no row');

  // The purchase row is the durable (store, environment, originalTransactionId)
  // binding — replay-safe via its unique constraint. A repeat link call or a
  // duplicate notification lands on the same row and mutates nothing here.
  await tx.insert(s.storekitPurchase).values({
    storeId: input.storeId,
    storekitAppId: input.storekitAppId ?? null,
    licenseId: lic.id,
    appKey: input.appKey,
    environment: input.source.environment,
    bundleId: input.source.bundleId,
    productId: input.source.productId ?? '',
    originalTransactionId: input.source.originalTransactionId,
    transactionId: input.source.transactionId ?? null,
    customerId: input.customerId ?? null,
    status: 'active',
    expiresAt,
    purchaseDate: input.source.purchaseDate != null ? new Date(input.source.purchaseDate) : null,
  }).onConflictDoNothing();

  let [purchase] = await tx.select({ id: s.storekitPurchase.id, customerId: s.storekitPurchase.customerId })
    .from(s.storekitPurchase)
    .where(and(
      eq(s.storekitPurchase.storeId, input.storeId),
      eq(s.storekitPurchase.environment, input.source.environment),
      eq(s.storekitPurchase.originalTransactionId, input.source.originalTransactionId),
    ))
    .limit(1);
  if (!purchase) throw new Error('StoreKit purchase upsert returned no row');
  // Self-heal: purchase existed but lost its license link (e.g. a license row
  // deleted out-of-band) — repoint it at the license we just ensured.
  await tx.update(s.storekitPurchase)
    .set({ licenseId: lic.id, updatedAt: now })
    .where(and(eq(s.storekitPurchase.id, purchase.id), isNull(s.storekitPurchase.licenseId)));

  if (input.customerId && !lic.customerId) {
    const [claimed] = await tx.update(s.license)
      .set({ customerId: input.customerId, updatedAt: new Date() })
      .where(and(eq(s.license.id, lic.id), isNull(s.license.customerId)))
      .returning({ id: s.license.id, customerId: s.license.customerId });
    if (claimed) lic = claimed;
    else {
      [lic] = await tx.select({ id: s.license.id, customerId: s.license.customerId })
        .from(s.license).where(eq(s.license.id, lic.id)).limit(1);
    }
  }
  if (input.customerId && !purchase.customerId) {
    const [claimedP] = await tx.update(s.storekitPurchase)
      .set({ customerId: input.customerId, updatedAt: new Date() })
      .where(and(eq(s.storekitPurchase.id, purchase.id), isNull(s.storekitPurchase.customerId)))
      .returning({ id: s.storekitPurchase.id, customerId: s.storekitPurchase.customerId });
    if (claimedP) purchase = claimedP;
  }
  if (!lic) throw new Error('StoreKit license claim lost its row');
  if (input.customerId && lic.customerId !== input.customerId) return { kind: 'account_conflict' };
  if (input.customerId && purchase.customerId && purchase.customerId !== input.customerId) {
    return { kind: 'account_conflict' };
  }
  return { kind: 'ok', id: lic.id, licenseKey };
}

export function isSandboxStoreKitLicense(metadata: unknown): boolean {
  return !!metadata
    && typeof metadata === 'object'
    && (metadata as Record<string, unknown>).storekit_environment === 'Sandbox';
}

// ── device activation for the StoreKit link path ────────────────────────────

type ActivationLicRow = {
  id: string;
  status: string;
  seats: number;
  expires_at: Date | string | null;
  metadata: unknown;
};

export type StoreKitActivationResult =
  | {
      kind: 'ok';
      activationId: string;
      deviceIdHash: string;
      activatedAt: Date | string | null;
      activationToken: string;
      lic: { id: string; expiresAt: Date | null; metadata: unknown };
    }
  | { kind: 'notfound' }
  | { kind: 'full' };

/** Activate a device against a StoreKit-minted license. Self-contained on
 *  purpose: it uses only the pre-existing license_activation columns so the
 *  StoreKit surface does not depend on the licensing-engine lane's in-flight
 *  lease/pool columns. Semantics mirror activateLicenseOnDevice:
 *    - the license row is locked FOR UPDATE so concurrent device links
 *      serialize on the seat cap;
 *    - same-device re-links are idempotent (unique(licenseId, deviceIdHash))
 *      and mint a FRESH activation token;
 *    - seats <= 0 means unlimited devices.
 *  The caller supplies a pre-hashed deviceIdHash (part of the wire contract);
 *  this function never sees the raw device id. */
export async function issueStoreKitActivation(
  tx: Tx,
  input: {
    storeId: string;
    appKey: string;
    licenseKey: string;
    deviceIdHash: string;
    deviceLabel?: string | null;
  },
): Promise<StoreKitActivationResult> {
  const licResult = await tx.execute(sql`
    SELECT id, status, seats, expires_at, metadata
    FROM license
    WHERE store_id    = ${input.storeId}
      AND license_key = ${input.licenseKey}
      AND app_key     = ${input.appKey}
    LIMIT 1
    FOR UPDATE
  `);
  const rawLic = (licResult as unknown as { rows: ActivationLicRow[] }).rows[0];
  if (!rawLic || rawLic.status !== 'active') return { kind: 'notfound' as const };

  const expiresAt = rawLic.expires_at != null ? new Date(rawLic.expires_at) : null;
  if (expiresAt != null && Math.floor(expiresAt.getTime() / 1000) <= Math.floor(Date.now() / 1000)) {
    return { kind: 'notfound' as const };
  }
  const lic = { id: rawLic.id, expiresAt, metadata: rawLic.metadata };

  const activationToken = newActivationToken();
  const activationTokenHash = hashActivationToken(activationToken);

  const existing = await tx
    .select({
      id: s.licenseActivation.id,
      deviceIdHash: s.licenseActivation.deviceIdHash,
      state: s.licenseActivation.state,
    })
    .from(s.licenseActivation)
    .where(eq(s.licenseActivation.licenseId, lic.id));
  // Tombstoned rows (state 'removed'/'revoked') keep their device_id_hash but
  // do NOT consume a seat — the cap counts only live activations.
  const activeExisting = existing.filter((row) => row.state === 'active');
  const sameDevice = existing.find((row) => row.deviceIdHash === input.deviceIdHash);

  // seats <= 0 is the unlimited-devices sentinel shared with
  // activateLicenseOnDevice; a positive value caps distinct deviceIdHashes.
  if (rawLic.seats > 0 && !sameDevice && activeExisting.length >= rawLic.seats) {
    return { kind: 'full' as const };
  }

  if (sameDevice) {
    const [updated] = await tx
      .update(s.licenseActivation)
      .set({
        activationTokenHash,
        lastSeenAt: new Date(),
        deviceLabel: input.deviceLabel ?? null,
        // Re-link clears any tombstone so a refunded-then-restored purchase
        // (or a previously removed device) re-activates cleanly.
        state: 'active',
        revokedAt: null,
        removedAt: null,
      })
      .where(eq(s.licenseActivation.id, sameDevice.id))
      .returning({ id: s.licenseActivation.id, activatedAt: s.licenseActivation.activatedAt });
    return {
      kind: 'ok' as const,
      activationId: updated?.id ?? sameDevice.id,
      deviceIdHash: input.deviceIdHash,
      activatedAt: updated?.activatedAt ?? null,
      activationToken,
      lic,
    };
  }

  const [created] = await tx.insert(s.licenseActivation).values({
    storeId: input.storeId,
    licenseId: lic.id,
    appKey: input.appKey,
    deviceIdHash: input.deviceIdHash,
    activationTokenHash,
    deviceLabel: input.deviceLabel ?? null,
  }).returning({ id: s.licenseActivation.id, activatedAt: s.licenseActivation.activatedAt });
  if (!created) throw new Error('license activation insert returned no id');
  return {
    kind: 'ok' as const,
    activationId: created.id,
    deviceIdHash: input.deviceIdHash,
    activatedAt: created.activatedAt ?? null,
    activationToken,
    lic,
  };
}

export interface StoreKitNotificationApplyInput {
  storeId: string;
  action: 'revoke' | 'restore' | 'renew' | 'expire' | 'ignore';
  /** Apple's signed environment claim — selects which purchase namespace
   *  (Sandbox vs Production) this notification applies to. */
  environment: string;
  originalTransactionId: string;
  transactionId: string | null;
  notificationType: string;
  notificationUUID: string;
  /** Signed expiresDate (ms epoch) when the notification carries one. */
  expiresDate: number | null;
  revocationDate: number | null;
}

/** Apply a verified App Store Server Notification to the purchase + license
 *  it refers to. Only ever mutates rows the purchase binding already
 *  established (or establishes one for renew/restore — see below); a
 *  notification for a purchase this store never saw is a no-op.
 *
 *  Returns the applied outcome so the caller can log/test it. */
export async function applyStoreKitNotification(
  tx: Tx,
  input: StoreKitNotificationApplyInput,
): Promise<'applied' | 'no_purchase' | 'ignored'> {
  if (input.action === 'ignore') return 'ignored';

  const [purchase] = await tx
    .select()
    .from(s.storekitPurchase)
    .where(and(
      eq(s.storekitPurchase.storeId, input.storeId),
      eq(s.storekitPurchase.environment, input.environment),
      eq(s.storekitPurchase.originalTransactionId, input.originalTransactionId),
    ))
    .limit(1);
  if (!purchase) return 'no_purchase';

  const now = new Date();
  const expiresAt = input.expiresDate != null ? new Date(input.expiresDate) : purchase.expiresAt;

  if (input.action === 'revoke') {
    await tx.update(s.storekitPurchase).set({
      status: 'revoked',
      transactionId: input.transactionId ?? purchase.transactionId,
      revocationDate: input.revocationDate != null ? new Date(input.revocationDate) : now,
      lastNotificationType: input.notificationType,
      lastNotificationUuid: input.notificationUUID,
      updatedAt: now,
    }).where(eq(s.storekitPurchase.id, purchase.id));
    if (purchase.licenseId) {
      // Ported revocation cascade (RS: license + licenseActivation +
      // licenseBridge — licenseBridge has no SellRight analog):
      //   1. license.status='revoked' blocks every downstream grant
      //      (activation tokens resolve through the license join; download/
      //      update eligibility requires status='active').
      //   2. Activations tombstone (state='revoked', generation bump) so any
      //      device lease/entitlement minted from them is rejected by the
      //      licensing engine's stale-generation check.
      await tx.update(s.license).set({ status: 'revoked', updatedAt: now }).where(eq(s.license.id, purchase.licenseId));
      await tx.execute(sql`
        UPDATE license_activation
        SET state = 'revoked', revoked_at = ${now}, generation = generation + 1
        WHERE license_id = ${purchase.licenseId} AND state = 'active'
      `);
    }
    return 'applied';
  }

  if (input.action === 'restore' || input.action === 'renew') {
    await tx.update(s.storekitPurchase).set({
      status: 'active',
      transactionId: input.transactionId ?? purchase.transactionId,
      expiresAt,
      revocationDate: null,
      lastNotificationType: input.notificationType,
      lastNotificationUuid: input.notificationUUID,
      updatedAt: now,
    }).where(eq(s.storekitPurchase.id, purchase.id));
    if (purchase.licenseId) {
      await tx.update(s.license).set({
        status: 'active',
        expiresAt,
        updatesUntil: expiresAt,
        updatedAt: now,
      }).where(eq(s.license.id, purchase.licenseId));
      // REFUND_REVERSED: un-tombstone activations revoked by the earlier
      // cascade so already-paired devices work again without re-linking.
      // generation stays bumped — stale pre-revoke leases stay rejected.
      await tx.execute(sql`
        UPDATE license_activation
        SET state = 'active', revoked_at = NULL
        WHERE license_id = ${purchase.licenseId} AND state = 'revoked'
      `);
    }
    return 'applied';
  }

  // expire
  await tx.update(s.storekitPurchase).set({
    status: 'expired',
    transactionId: input.transactionId ?? purchase.transactionId,
    expiresAt,
    lastNotificationType: input.notificationType,
    lastNotificationUuid: input.notificationUUID,
    updatedAt: now,
  }).where(eq(s.storekitPurchase.id, purchase.id));
  if (purchase.licenseId) {
    await tx.update(s.license).set({ status: 'expired', expiresAt, updatedAt: now }).where(eq(s.license.id, purchase.licenseId));
  }
  return 'applied';
}
