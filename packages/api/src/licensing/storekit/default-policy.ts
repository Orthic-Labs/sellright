// `sellright-default` StoreKit policy (STOREKIT §3 rule 5). Reproduces the
// pre-3.5 SellRight behaviour byte-for-byte: no paired proof, materialize only
// for renew/restore, generic licence + activation issuance, restore re-activates
// tombstoned devices, and the SellRight wire mapping.
import { issueStoreKitActivation, ensureStoreKitLicense, type VerifiedStoreKitLicenseSource } from '../storekit-license.js';
import type { StoreKitTransactionPayload } from '../storekit-verify.js';
import { registerStoreKitPolicy, type HttpResult, type IssueInput, type IssueResult, type LinkOutcome, type StoreKitPolicy } from './policy.js';

/** Engine source mapping for a verified transaction (fields SellRight stores on the purchase row). */
export function sourceFromTransaction(p: StoreKitTransactionPayload): VerifiedStoreKitLicenseSource {
  return {
    originalTransactionId: p.originalTransactionId,
    transactionId: p.transactionId,
    bundleId: p.bundleId,
    environment: p.environment,
    productId: p.productId,
    purchaseDate: p.purchaseDate,
    expiresDate: p.expiresDate,
  };
}

export const LINK_MESSAGES = {
  noConfig: 'StoreKit purchases are not configured for this app',
  unverified: 'the App Store transaction could not be verified',
  notForApp: 'this transaction was not issued for this app',
  environment: 'unexpected App Store environment',
  revoked: 'this purchase was refunded or revoked by Apple',
  unauth: 'not authenticated, or purchase already linked to a different account',
  notActivated: 'license could not be activated',
  seatLimit: 'device seat limit reached',
  busy: 'purchase is being updated; retry shortly',
} as const;

/** SellRight wire mapping of a link outcome (also the base the plugin policies extend). */
export function sellrightRespond(o: LinkOutcome): HttpResult {
  switch (o.kind) {
    case 'no_config':
      return { status: 400, message: LINK_MESSAGES.noConfig };
    case 'verify_failed': {
      const r = o.reason;
      if (r === 'malformed' || r === 'bad_signature') return { status: 400, message: LINK_MESSAGES.unverified };
      if (r === 'wrong_bundle' || r === 'wrong_product') return { status: 400, message: LINK_MESSAGES.notForApp };
      if (r === 'wrong_environment') return { status: 400, message: LINK_MESSAGES.environment };
      return { status: 422, message: LINK_MESSAGES.revoked };
    }
    case 'unauth':
      return { status: 401, message: LINK_MESSAGES.unauth };
    case 'validation':
      return { status: o.status, message: o.message };
    case 'lock_unstable':
      return { status: 503, message: LINK_MESSAGES.busy };
    case 'issue_rejected': {
      const r = o.result;
      if (r.kind === 'account_conflict') return { status: 401, message: LINK_MESSAGES.unauth };
      if (r.code === 'seat_limit') return { status: 409, message: LINK_MESSAGES.seatLimit };
      return { status: 400, message: LINK_MESSAGES.notActivated };
    }
    case 'issued': {
      const cred = o.result.credential;
      if (!cred || cred.kind !== 'activation') return { status: 400, message: LINK_MESSAGES.notActivated };
      const activatedAt = cred.activatedAt ? new Date(cred.activatedAt).toISOString() : null;
      return {
        status: 200,
        body: {
          ok: true,
          activationToken: cred.activationToken,
          lease: {
            leaseId: cred.activationId,
            deviceIdHash: cred.deviceIdHash,
            pool: 'mobile',
            entitlement: o.result.entitlement?.tier ?? null,
            issuedAt: activatedAt,
            expiresAt: cred.lic.expiresAt?.toISOString() ?? null,
            graceSeconds: 0,
            generation: 0,
            signature: null,
          },
        },
      };
    }
  }
}

export const sellrightDefaultPolicy: StoreKitPolicy = {
  id: 'sellright-default',
  async validateLink(i) {
    return { ok: true, proofs: { primary: i.primary, paired: null }, facts: {} };
  },
  decideMaterialize(i) {
    if (i.action !== 'renew' && i.action !== 'restore') return { materialize: false };
    return { materialize: true, entitlement: i.productId ? i.appCfg.productMap[i.productId] ?? null : null };
  },
  async issue(tx, _held, i: IssueInput): Promise<IssueResult> {
    if (i.purpose === 'materialize') {
      const ensured = await ensureStoreKitLicense(tx, {
        storeId: i.storeId,
        storekitAppId: i.appCfg.id,
        appKey: i.appCfg.appKey,
        source: i.source,
        entitlement: i.entitlement,
      });
      if (ensured.kind !== 'ok') return { kind: 'account_conflict' };
      return { kind: 'ok', license: { id: ensured.id, licenseKey: ensured.licenseKey }, entitlement: i.entitlement, credential: null, disclosed: {} };
    }
    const ensured = await ensureStoreKitLicense(tx, {
      storeId: i.storeId,
      storekitAppId: i.appCfg.id,
      appKey: i.appCfg.appKey,
      customerId: i.customerId,
      entitlement: i.entitlement,
      source: sourceFromTransaction(i.proofs.primary),
    });
    if (ensured.kind === 'account_conflict') return { kind: 'account_conflict' };
    const activated = await issueStoreKitActivation(tx, {
      storeId: i.storeId,
      appKey: i.appCfg.appKey,
      licenseKey: ensured.licenseKey,
      deviceIdHash: i.device.deviceIdHash,
      deviceLabel: i.device.label,
    });
    if (activated.kind === 'notfound') return { kind: 'rejected', code: 'notfound' };
    if (activated.kind === 'full') return { kind: 'rejected', code: 'seat_limit' };
    return {
      kind: 'ok',
      license: { id: ensured.id, licenseKey: ensured.licenseKey },
      entitlement: i.entitlement,
      credential: { ...activated, kind: 'activation' },
      disclosed: {},
    };
  },
  async cascade() {
    return { restoreActivations: true };
  },
  respond: sellrightRespond,
};

registerStoreKitPolicy(sellrightDefaultPolicy);
