// Apple StoreKit 2 signed-transaction (JWS) verification — ported upstream
// from RightSites (storekit-official-verifier / storekit-sandbox-path) and
// genericized: every deployment-specific input (bundleId, appAppleId,
// allowed product ids, sandbox policy) arrives as explicit options/config,
// sourced from the `storekit_app` table via storekit-config.ts — never from
// the client request.
//
// This module delegates ALL chain-of-trust work to Apple's own
// `@apple/app-store-server-library` (`SignedDataVerifier`), which implements
// Apple's actual trust model (multi-root, EKU-aware x5c chain checking),
// online OCSP revocation checking, and correct signed-date semantics — and
// which Apple maintains as any of that changes. An earlier hand-rolled
// verifier upstream was found to validate against itself (a throwaway CA)
// and to miss: multi-root trust, environment enforcement, appAppleId,
// signed-date validity semantics, and EKU/revocation handling. Do not
// reintroduce hand-rolled verification here.
//
// PRECISE CLAIM about what `verifyAndDecodeTransaction` (the ONLY method of
// the library this module calls for transactions) actually checks, confirmed
// by reading its source (`jws_verification.js`, `SignedDataVerifier.
// verifyAndDecodeTransaction`) rather than assumed from the constructor's
// parameter list:
//   - signature chain to a trusted root (`appleRootCertificateDerBuffers`)
//     — checked.
//   - `decodedJWT.bundleId !== this.bundleId` → throws
//     INVALID_APP_IDENTIFIER — checked.
//   - `decodedJWT.environment !== this.environment` → throws
//     INVALID_ENVIRONMENT — checked.
//   - `appAppleId` — NOT checked by this method at all. The constructor
//     REQUIRES it (throws synchronously) when `environment === PRODUCTION`,
//     but `verifyAndDecodeTransaction`'s body never reads `this.appAppleId`
//     and a `JWSTransaction` payload carries no `appAppleId` field to compare
//     it against in the first place — that field only exists on OTHER payload
//     types this module never verifies (App Store Server Notifications,
//     `AppTransaction`, Retention Messaging requests), where the library's
//     corresponding `verifyAndDecode*` methods DO compare it. Configuring an
//     appAppleId therefore satisfies the constructor's fail-closed
//     requirement for Production, but it is not a check "on this
//     transaction" and must never be described as one.
//
// Environment handling: there is deliberately NO single "which environment"
// setting. Apple's own docs state TestFlight in-app purchases ALWAYS use the
// Sandbox environment, so one global value cannot serve both a live
// Production release and TestFlight dogfood on the same backend.
// `verifyStoreKitTransactionForDeployment` instead tries EACH environment
// the deployment permits (Production when appAppleId is configured, Sandbox
// when the app's/store's policy allows it) and decides which matched from
// Apple's OWN signed `environment` claim inside the JWS — never from a
// client-supplied field or a config value meaning "any environment".
import { Environment, SignedDataVerifier, VerificationException, VerificationStatus } from '@apple/app-store-server-library';
import { appleRootCertificateDerBuffers } from './apple-root-certificates.js';
import { verifyAcrossEnvironments } from './storekit-verify-environments.js';

export { Environment };

export interface StoreKitTransactionPayload {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  /** 'Sandbox' or 'Production' (Apple's `Environment` enum, stringified). */
  environment: string;
  purchaseDate: number;
  originalPurchaseDate: number | null;
  /** Auto-renewable subscription expiry (ms epoch), when Apple includes it. */
  expiresDate: number | null;
  /** App-account token the purchasing app set at buy time (UUID), if any. */
  appAccountToken: string | null;
  revocationDate: number | null;
  revocationReason: number | null;
  type: string | null;
}

export type VerifyStoreKitResult =
  | { kind: 'ok'; payload: StoreKitTransactionPayload }
  | { kind: 'malformed' }
  | { kind: 'bad_signature' }
  | { kind: 'wrong_bundle' }
  | { kind: 'wrong_product' }
  | { kind: 'wrong_environment' }
  | { kind: 'revoked' };

export interface VerifyStoreKitOptions {
  allowedProductIds: readonly string[];
  /** The bundle id this app's StoreKit IAP is sold under — sourced from
   *  config (storekit_app.bundle_id), never from the request. */
  bundleId: string;
  /** The ONE App Store environment THIS PARTICULAR verifier accepts —
   *  never from the request payload. Each call still pins exactly ONE
   *  environment; the caller (`verifyStoreKitTransactionForDeployment`
   *  below) calls this once per permitted environment instead of trusting
   *  any single configured value. This is what stops a Sandbox transaction
   *  from being accepted BY THE PRODUCTION VERIFIER, or vice versa. */
  environment: Environment;
  /** Required by Apple's `SignedDataVerifier` CONSTRUCTOR whenever
   *  `environment` is Production (it throws synchronously if omitted);
   *  omitted (and unused) for Sandbox. Sourced from config
   *  (storekit_app.app_apple_id). NOT compared against anything in the
   *  decoded transaction by `verifyAndDecodeTransaction` — see this file's
   *  header for the precise claim and why. */
  appAppleId?: number;
  /** `enableOnlineChecks` for the verifier: turns on OCSP revocation
   *  checking for the cert chain and, per the library's own semantics, uses
   *  the current time (rather than the transaction's signed date) for
   *  certificate-validity checks, matching how Apple's own guidance
   *  describes online verification. Requires outbound network access to
   *  Apple's OCSP responders at verification time. Default true — the only
   *  legitimate off is a network that cannot reach OCSP (offline dev/CI),
   *  expressed via STOREKIT_ONLINE_CHECKS in the route layer. */
  onlineChecks?: boolean;
  /** TEST-ONLY: inject a `SignedDataVerifier` built against a throwaway CA
   *  (via its own root-cert list) instead of Apple's real pinned roots, so
   *  tests can prove the wiring and result-mapping logic without weakening
   *  what production trusts. Real Apple transactions can only be signed by
   *  Apple's actual CA key, which no test can reproduce. Production code
   *  paths must never pass this. */
  _verifierForTests?: SignedDataVerifier;
}

function buildVerifier(opts: VerifyStoreKitOptions): SignedDataVerifier {
  if (opts._verifierForTests) return opts._verifierForTests;
  return new SignedDataVerifier(
    appleRootCertificateDerBuffers(),
    opts.onlineChecks ?? true,
    opts.environment,
    opts.bundleId,
    opts.appAppleId,
  );
}

/** Verify an Apple StoreKit 2 signed transaction and return its payload
 *  ONLY if every check passes: signature chain to a real Apple root,
 *  bundle id, environment, and non-revocation. This is the sole source of
 *  truth the caller should use for `originalTransactionId`/`bundleId`/
 *  `productId`/revocation state — never trust a client-supplied copy of
 *  these fields, even alongside a verified JWS (the JWS is authoritative;
 *  anything else is discarded). */
export async function verifyStoreKitTransaction(jws: string, opts: VerifyStoreKitOptions): Promise<VerifyStoreKitResult> {
  const verifier = buildVerifier(opts);

  let decoded: Awaited<ReturnType<SignedDataVerifier['verifyAndDecodeTransaction']>>;
  try {
    decoded = await verifier.verifyAndDecodeTransaction(jws);
  } catch (err) {
    if (err instanceof VerificationException) {
      switch (err.status) {
        case VerificationStatus.INVALID_APP_IDENTIFIER:
          return { kind: 'wrong_bundle' };
        case VerificationStatus.INVALID_ENVIRONMENT:
          return { kind: 'wrong_environment' };
        case VerificationStatus.FAILURE:
          // Validator rejected the decoded JWT shape outright (e.g. not a
          // parseable JWT at all).
          return { kind: 'malformed' };
        default:
          // VERIFICATION_FAILURE, RETRYABLE_VERIFICATION_FAILURE,
          // INVALID_CHAIN_LENGTH, INVALID_CERTIFICATE — every case where
          // the signature/chain itself didn't check out.
          return { kind: 'bad_signature' };
      }
    }
    return { kind: 'malformed' };
  }

  if (!decoded.bundleId || !decoded.productId || !decoded.originalTransactionId || !decoded.transactionId) {
    return { kind: 'malformed' };
  }

  if (!opts.allowedProductIds.includes(decoded.productId)) return { kind: 'wrong_product' };

  const revocationDate = typeof decoded.revocationDate === 'number' ? decoded.revocationDate : null;
  if (revocationDate !== null) return { kind: 'revoked' };

  return {
    kind: 'ok',
    payload: {
      transactionId: decoded.transactionId,
      originalTransactionId: decoded.originalTransactionId,
      bundleId: decoded.bundleId,
      productId: decoded.productId,
      environment: typeof decoded.environment === 'string' ? decoded.environment : '',
      purchaseDate: decoded.purchaseDate ?? 0,
      originalPurchaseDate: decoded.originalPurchaseDate ?? null,
      expiresDate: typeof decoded.expiresDate === 'number' ? decoded.expiresDate : null,
      appAccountToken: typeof decoded.appAccountToken === 'string' ? decoded.appAccountToken : null,
      revocationDate: null,
      revocationReason: typeof decoded.revocationReason === 'number' ? decoded.revocationReason : null,
      type: typeof decoded.type === 'string' ? decoded.type : null,
    },
  };
}

/** Deployment-level config for `verifyStoreKitTransactionForDeployment`
 *  (and the notification variant below). One per configured app — see
 *  storekit-config.ts, which builds these from `storekit_app` rows. */
export interface StoreKitDeploymentConfig {
  bundleId: string;
  allowedProductIds: readonly string[];
  /** Numeric App Store Connect app id. When present, Production
   *  verification is attempted (required by `SignedDataVerifier`'s own
   *  constructor for Production — see this file's header). When absent,
   *  Production is never attempted at all, not merely rejected after the
   *  fact: this deployment fails closed on real Production purchases (they
   *  simply never match any configured attempt) while Sandbox/TestFlight
   *  purchases keep verifying normally. Sourced from config
   *  (storekit_app.app_apple_id), never the request. */
  appAppleId?: number;
  /** Environment policy: may this app accept Sandbox-environment purchases
   *  (TestFlight / sandbox-account testing)? When false the Sandbox verifier
   *  is never attempted — a Sandbox-labelled transaction fails
   *  `wrong_environment` rather than being silently accepted. Default true;
   *  the effective value is per-app `allow_sandbox` AND the deployment-wide
   *  STOREKIT_ALLOW_SANDBOX env, resolved in storekit-config.ts. */
  allowSandbox?: boolean;
  /** Passed through to `VerifyStoreKitOptions.onlineChecks`. Default true. */
  onlineChecks?: boolean;
  /** TEST-ONLY: inject the two `SignedDataVerifier` instances (built
   *  against a throwaway CA, `enableOnlineChecks: false`) instead of the
   *  real Apple-root/online-OCSP verifiers `buildVerifier` would otherwise
   *  construct — same escape hatch as `VerifyStoreKitOptions._verifierForTests`,
   *  just one per environment so a test can exercise the fall-through order.
   *  `sandbox` is always used when provided; `production` is only used when
   *  `appAppleId` is also set (matching real deployment behavior: no
   *  appAppleId means Production is never attempted, test or not).
   *  Production code paths must never pass this. */
  _verifiersForTests?: { production?: SignedDataVerifier; sandbox?: SignedDataVerifier };
}

export type VerifyStoreKitForDeploymentResult = VerifyStoreKitResult & {
  /** Which environment's verifier actually matched — only meaningful
   *  (non-null) when `kind === 'ok'`. Derived ENTIRELY from Apple's own
   *  signed `environment` claim inside the JWS (each candidate verifier
   *  only accepts its own pinned environment value); never read from, or
   *  influenced by, anything the client sent. Callers use this to tag the
   *  resulting license/purchase row with its true origin so a
   *  Sandbox-origin entitlement can be kept out of capabilities meant only
   *  for a real Production purchase. */
  matchedEnvironment: Environment | null;
};

/** Verify a client-submitted JWS against every environment this app is
 *  configured to accept genuine Apple-signed transactions for — Production
 *  (the public App Store release, only when appAppleId is configured) and,
 *  when policy allows, Sandbox (every TestFlight distribution: Apple's own
 *  docs state TestFlight in-app purchases ALWAYS use the Sandbox
 *  environment —
 *  https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox).
 *
 *  There is no single "which environment" switch to misconfigure: both
 *  candidate verifiers are constructed independently (each still pinned to
 *  exactly ONE `Environment` value) and `verifyAcrossEnvironments`
 *  (storekit-verify-environments.ts) tries them in a fixed server-decided
 *  order, stopping at the first one whose failure ISN'T specifically
 *  "wrong environment for this verifier" — see that module's own header
 *  for why a genuine failure (bad signature, revoked, wrong bundle/
 *  product) for the environment that DOES match must never be masked by
 *  silently falling through to try the other one. The environment that
 *  ends up matching is decided by Apple's OWN signed claim inside the JWS,
 *  covered by the same signature this module already verifies — never by
 *  a client-supplied field, and never by which verifier happens to run
 *  first (a Production transaction can only ever satisfy the Production
 *  verifier; trying it against Sandbox first would still just produce
 *  'wrong_environment' and fall through to Production). */
export async function verifyStoreKitTransactionForDeployment(
  jws: string,
  config: StoreKitDeploymentConfig,
): Promise<VerifyStoreKitForDeploymentResult> {
  const attempts: Array<{ label: Environment; verify: (j: string) => Promise<VerifyStoreKitResult> }> = [];
  if (config.appAppleId !== undefined && config.appAppleId !== null) {
    attempts.push({
      label: Environment.PRODUCTION,
      verify: (j) => verifyStoreKitTransaction(j, {
        allowedProductIds: config.allowedProductIds,
        bundleId: config.bundleId,
        environment: Environment.PRODUCTION,
        appAppleId: config.appAppleId,
        onlineChecks: config.onlineChecks,
        _verifierForTests: config._verifiersForTests?.production,
      }),
    });
  }
  if (config.allowSandbox !== false) {
    // Sandbox is attempted whenever policy permits — every non-Production
    // distribution channel (TestFlight, local Xcode/sandbox-account testing)
    // genuinely produces Sandbox transactions, and Sandbox verification
    // needs no appAppleId at all (Apple's constructor only requires it for
    // Production).
    attempts.push({
      label: Environment.SANDBOX,
      verify: (j) => verifyStoreKitTransaction(j, {
        allowedProductIds: config.allowedProductIds,
        bundleId: config.bundleId,
        _verifierForTests: config._verifiersForTests?.sandbox,
        onlineChecks: config.onlineChecks,
        environment: Environment.SANDBOX,
      }),
    });
  }
  const { result, matchedLabel } = await verifyAcrossEnvironments(jws, attempts);
  return { ...result, matchedEnvironment: matchedLabel };
}

export interface StoreKitNotificationPayload {
  notificationType: string;
  notificationUUID: string;
  environment: string;
  originalTransactionId: string | null;
  transactionId: string | null;
  productId: string | null;
  /** Auto-renewable expiry from the nested transaction (ms epoch), if any. */
  expiresDate: number | null;
  revocationDate: number | null;
}

export type VerifyStoreKitNotificationResult =
  | { kind: 'ok'; payload: StoreKitNotificationPayload }
  | { kind: 'malformed' }
  | { kind: 'bad_signature' }
  | { kind: 'retryable' }
  | { kind: 'wrong_bundle' }
  | { kind: 'wrong_product' }
  | { kind: 'wrong_environment' };

async function verifyStoreKitNotification(
  signedPayload: string,
  opts: VerifyStoreKitOptions,
): Promise<VerifyStoreKitNotificationResult> {
  const verifier = buildVerifier(opts);
  try {
    const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
    if (!decoded.notificationType || !decoded.notificationUUID || !decoded.data?.environment) {
      return { kind: 'malformed' };
    }
    const signedTransaction = decoded.data.signedTransactionInfo;
    if (!signedTransaction) {
      return {
        kind: 'ok',
        payload: {
          notificationType: String(decoded.notificationType),
          notificationUUID: decoded.notificationUUID,
          environment: String(decoded.data.environment),
          originalTransactionId: null,
          transactionId: null,
          productId: null,
          expiresDate: null,
          revocationDate: null,
        },
      };
    }
    const transaction = await verifier.verifyAndDecodeTransaction(signedTransaction);
    if (!transaction.originalTransactionId || !transaction.transactionId || !transaction.productId) {
      return { kind: 'malformed' };
    }
    if (!opts.allowedProductIds.includes(transaction.productId)) return { kind: 'wrong_product' };
    return {
      kind: 'ok',
      payload: {
        notificationType: String(decoded.notificationType),
        notificationUUID: decoded.notificationUUID,
        environment: String(decoded.data.environment),
        originalTransactionId: transaction.originalTransactionId,
        transactionId: transaction.transactionId,
        productId: transaction.productId,
        expiresDate: typeof transaction.expiresDate === 'number' ? transaction.expiresDate : null,
        revocationDate: typeof transaction.revocationDate === 'number' ? transaction.revocationDate : null,
      },
    };
  } catch (err) {
    if (err instanceof VerificationException) {
      switch (err.status) {
        case VerificationStatus.INVALID_APP_IDENTIFIER:
          return { kind: 'wrong_bundle' };
        case VerificationStatus.INVALID_ENVIRONMENT:
          return { kind: 'wrong_environment' };
        case VerificationStatus.FAILURE:
          return { kind: 'malformed' };
        case VerificationStatus.RETRYABLE_VERIFICATION_FAILURE:
          return { kind: 'retryable' };
        default:
          return { kind: 'bad_signature' };
      }
    }
    return { kind: 'malformed' };
  }
}

/** Verify App Store Server Notifications v2 against every permitted
 *  environment. Outer notification plus nested transaction are both
 *  verified by Apple's library; purchase identity is never read from
 *  untrusted request fields. */
export async function verifyStoreKitNotificationForDeployment(
  signedPayload: string,
  config: StoreKitDeploymentConfig,
): Promise<VerifyStoreKitNotificationResult & { matchedEnvironment: Environment | null }> {
  const attempts: Array<{ label: Environment; verify: (j: string) => Promise<VerifyStoreKitNotificationResult> }> = [];
  if (config.appAppleId !== undefined && config.appAppleId !== null) {
    attempts.push({
      label: Environment.PRODUCTION,
      verify: (j) => verifyStoreKitNotification(j, {
        allowedProductIds: config.allowedProductIds,
        bundleId: config.bundleId,
        environment: Environment.PRODUCTION,
        appAppleId: config.appAppleId,
        onlineChecks: config.onlineChecks,
        _verifierForTests: config._verifiersForTests?.production,
      }),
    });
  }
  if (config.allowSandbox !== false) {
    attempts.push({
      label: Environment.SANDBOX,
      verify: (j) => verifyStoreKitNotification(j, {
        allowedProductIds: config.allowedProductIds,
        bundleId: config.bundleId,
        environment: Environment.SANDBOX,
        onlineChecks: config.onlineChecks,
        _verifierForTests: config._verifiersForTests?.sandbox,
      }),
    });
  }
  const { result, matchedLabel } = await verifyAcrossEnvironments(signedPayload, attempts);
  return { ...result, matchedEnvironment: matchedLabel };
}
