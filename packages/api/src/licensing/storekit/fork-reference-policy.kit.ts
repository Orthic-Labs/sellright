// TEST-ONLY reproduction of the RightSites heardright StoreKit branches, expressed
// as a StoreKitPolicy (de-fork plan 3.5 fork-reference kit). It is not registered
// by production code. Source of each rule (fork checkout fc8715e8):
//   platform ∉ {ios, ipados} → invalid_purchase        routes/storekit-webhooks.ts:196
//   upgrade product needs a verified paired proof       routes/storekit-webhooks.ts:198–200
//   materialize any action except the upgrade product   routes/storekit-webhooks.ts:117
//   mobile source: product, bundle, env, appAccountToken licensing/storekit-license.ts:73–80
//   credit used by a different upgrade key              licensing/storekit-license.ts:115–122 (metadata part only)
//   restore does not un-tombstone activations           licensing/storekit-license.ts:478
// Not reproduced (recorded in docs/policies/STOREKIT-POLICY.md): device lease issuance,
// order-released credit (releasedUpgradeOrder), reservations, route-level request
// extension merge, lockPlan dependents cascade.
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import type { HeldLocks } from '../../db/locks.js';
import * as s from '../../db/schema.js';
import { ensureStoreKitLicense, issueStoreKitActivation, storeKitLicenseKey, type VerifiedStoreKitLicenseSource } from '../storekit-license.js';
import type { StoreKitTransactionPayload } from '../storekit-verify.js';
import { sellrightRespond, sourceFromTransaction } from './default-policy.js';
import type { HttpResult, IssueInput, IssueResult, LinkOutcome, StoreKitPolicy } from './policy.js';

export const FORK_PRODUCTS = {
  mobile: 'app.heardright.pro.ios.lifetime',
  legacy: 'app.heardright.pro.lifetime',
  full: 'app.heardright.pro.full.lifetime',
  upgrade: 'app.heardright.pro.ios.upgrade',
} as const;

export const FORK_APP_KEY = 'heardright';
export const FORK_MESSAGE = 'valid uncredited Mobile Pro purchase proof is required';

const scopeOf = (productId: string): 'mobile' | 'full' | null =>
  productId === FORK_PRODUCTS.mobile ? 'mobile'
    : productId === FORK_PRODUCTS.legacy || productId === FORK_PRODUCTS.full || productId === FORK_PRODUCTS.upgrade ? 'full'
      : null;

const record = (v: unknown): Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Mobile proof rule (storekit-license.ts:73–80): same product family, bundle and environment, equal non-null appAccountToken. */
export function mobileSourceMatches(mobile: StoreKitTransactionPayload, upgrade: StoreKitTransactionPayload): boolean {
  return mobile.productId === FORK_PRODUCTS.mobile
    && mobile.bundleId === upgrade.bundleId
    && mobile.environment === upgrade.environment
    && !!mobile.appAccountToken
    && !!upgrade.appAccountToken
    && mobile.appAccountToken === upgrade.appAccountToken;
}

async function mergeLicenseMetadata(tx: Tx, licenseId: string, patch: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`UPDATE license SET metadata = metadata || ${JSON.stringify(patch)}::jsonb WHERE id = ${licenseId}`);
}

async function issueForkLink(tx: Tx, i: Extract<IssueInput, { purpose: 'link' }>): Promise<IssueResult> {
  const primary = i.proofs.primary;
  const scope = scopeOf(primary.productId);
  if (!scope) return { kind: 'rejected', code: 'invalid_product' };

  let mobileLicenseId: string | null = null;
  let upgradeKey: string | null = null;
  if (primary.productId === FORK_PRODUCTS.upgrade) {
    const mobile = i.proofs.paired;
    if (!mobile || !mobileSourceMatches(mobile, primary)) return { kind: 'rejected', code: 'mobile_source_required' };
    // Credit: the mobile licence may already carry a different upgrade key (storekit-license.ts:115–122).
    const [mobileRow] = await tx.select({ licenseId: s.storekitPurchase.licenseId }).from(s.storekitPurchase).where(and(
      eq(s.storekitPurchase.storeId, i.storeId),
      eq(s.storekitPurchase.environment, mobile.environment),
      eq(s.storekitPurchase.originalTransactionId, mobile.originalTransactionId),
    )).limit(1);
    upgradeKey = storeKitLicenseKey(FORK_APP_KEY, sourceFromTransaction(primary));
    if (mobileRow?.licenseId) {
      const [mobileLic] = await tx.select().from(s.license).where(eq(s.license.id, mobileRow.licenseId)).limit(1);
      const priorKey = record(mobileLic?.metadata).mobile_upgrade_storekit_key;
      if (typeof priorKey === 'string' && priorKey !== upgradeKey) {
        const [prior] = await tx.select({ status: s.license.status, metadata: s.license.metadata })
          .from(s.license).where(eq(s.license.licenseKey, priorKey)).limit(1);
        const priorRevoked = prior?.status === 'revoked' && record(prior.metadata).storekit_purchase_revoked === true;
        if (!priorRevoked) return { kind: 'rejected', code: 'credit_used' };
      }
    }
    const ensuredMobile = await ensureStoreKitLicense(tx, {
      storeId: i.storeId, storekitAppId: i.appCfg.id, appKey: FORK_APP_KEY,
      customerId: i.customerId, entitlement: null, source: sourceFromTransaction(mobile),
    });
    if (ensuredMobile.kind !== 'ok') return { kind: 'account_conflict' };
    mobileLicenseId = ensuredMobile.id;
  }

  const ensured = await ensureStoreKitLicense(tx, {
    storeId: i.storeId, storekitAppId: i.appCfg.id, appKey: FORK_APP_KEY,
    customerId: i.customerId, entitlement: i.entitlement, source: sourceFromTransaction(primary),
  });
  if (ensured.kind === 'account_conflict') return { kind: 'account_conflict' };
  if (mobileLicenseId) {
    await mergeLicenseMetadata(tx, mobileLicenseId, { mobile_upgrade_storekit_key: ensured.licenseKey });
    await mergeLicenseMetadata(tx, ensured.id, { mobile_upgrade_source_id: mobileLicenseId });
  }

  const activated = await issueStoreKitActivation(tx, {
    storeId: i.storeId, appKey: FORK_APP_KEY, licenseKey: ensured.licenseKey,
    deviceIdHash: i.device.deviceIdHash, deviceLabel: i.device.label,
  });
  if (activated.kind === 'notfound') return { kind: 'rejected', code: 'notfound' };
  if (activated.kind === 'full') return { kind: 'rejected', code: 'seat_limit' };
  const disclosed = primary.environment === 'Production' && scope === 'full' ? { licenseKey: ensured.licenseKey } : {};
  return {
    kind: 'ok',
    license: { id: ensured.id, licenseKey: ensured.licenseKey },
    entitlement: i.entitlement,
    credential: { ...activated, kind: 'activation' },
    disclosed,
  };
}

export const forkReferencePolicy: StoreKitPolicy = {
  id: 'rightsuite-fork-reference',
  appKeys: [FORK_APP_KEY],
  async validateLink(i) {
    const platform = i.request.platform;
    if (platform && platform !== 'ios' && platform !== 'ipados') {
      return { ok: false, status: 400, message: FORK_MESSAGE };
    }
    const mobileJws = i.request.extensions.signedMobileTransactionInfo;
    let paired: StoreKitTransactionPayload | null = null;
    if (typeof mobileJws === 'string') {
      const v = await i.verifyPaired(mobileJws);
      if (v.kind === 'ok') paired = v.payload;
    }
    if (i.primary.productId === FORK_PRODUCTS.upgrade && !paired) {
      return { ok: false, status: 400, message: FORK_MESSAGE };
    }
    return { ok: true, proofs: { primary: i.primary, paired }, facts: {} };
  },
  decideMaterialize(i) {
    if (i.productId === FORK_PRODUCTS.upgrade) return { materialize: false };
    return { materialize: true, entitlement: i.productId ? i.appCfg.productMap[i.productId] ?? null : null };
  },
  async issue(tx, _held: HeldLocks, i) {
    if (i.purpose === 'materialize') {
      if (!scopeOf(i.source.productId ?? '')) return { kind: 'rejected', code: 'invalid_product' };
      const ensured = await ensureStoreKitLicense(tx, {
        storeId: i.storeId, storekitAppId: i.appCfg.id, appKey: FORK_APP_KEY,
        source: i.source as VerifiedStoreKitLicenseSource, entitlement: i.entitlement,
      });
      if (ensured.kind !== 'ok') return { kind: 'rejected', code: 'invalid_product' };
      return { kind: 'ok', license: { id: ensured.id, licenseKey: ensured.licenseKey }, entitlement: i.entitlement, credential: null, disclosed: {} };
    }
    return issueForkLink(tx, i);
  },
  async cascade() {
    return { restoreActivations: false };
  },
  respond(o: LinkOutcome): HttpResult {
    // Fork wire: any non-ok, non-account-conflict issue result is the invalid-purchase 400.
    if (o.kind === 'issue_rejected' && o.result.kind === 'rejected'
      && (o.result.code === 'invalid_product' || o.result.code === 'mobile_source_required' || o.result.code === 'credit_used' || o.result.code === 'platform_rejected')) {
      return { status: 400, message: FORK_MESSAGE };
    }
    if (o.kind === 'issued') {
      const base = sellrightRespond(o);
      if (base.status !== 200) return base;
      const licenseKey = o.result.disclosed.licenseKey;
      return typeof licenseKey === 'string' ? { status: 200, body: { ...base.body, licenseKey } } : base;
    }
    return sellrightRespond(o);
  },
};
