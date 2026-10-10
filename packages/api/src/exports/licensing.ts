/** `@sellright/api/licensing` — registrars are called from a plugin's `services` phase, never at import. */
export { findActivationByToken, recordCanonicalEntitlementIssuance } from '../licensing/activations.js';
export { appKeyHeaderNames, deviceHeaderName, firstHeader } from '../licensing/app-headers.js';
export {
  issueDeviceLease, removeDeviceOffline, renewDeviceLease, revokeDeviceRemote,
  type LeaseEnvelope, type Platform,
} from '../licensing/device-leases.js';
export { registerDevicePolicy } from '../licensing/device-policy.js';
export {
  EntitlementVeto, registerEntitlementProvider,
  type ActivateEntitlementContext, type EntitlementFields, type RefreshEntitlementContext,
} from '../licensing/entitlement-provider.js';
export { buildEntitlements, canReceiveTieredUpdate, registerTierCatalog, resolveAuthorizationTier } from '../licensing/entitlements.js';
export { newLicenseKey } from '../licensing/issue.js';
export { planLicenseLifecycle } from '../licensing/license-lifecycle.js';
export { mintLicense } from '../licensing/mint.js';
export { createRuntimeArtifactManifestTools } from '../licensing/runtime-artifact-manifest.js';
export { signEntitlement, signLeaseEnvelope, verifyToken, type SignedPayload } from '../licensing/sign.js';
export { bearerToken, hashActivationToken } from '../licensing/tokens.js';
export {
  PUBLIC_PATCH_CHANNELS, isPatchChannel, normalizeReleasePlatform, parsePatchRelease, patchChannel, validateReleaseRegistration,
} from '../licensing/update-tier.js';
export {
  ALLOW, DENY_NOTFOUND, denyPlatform, registerEntitlementPolicy,
  type AuthorizeContext, type CapacityContext, type ClaimsContext, type EntitlementPolicy, type ExtensionPath, type PolicyClaims,
  type PolicyDecision, type PolicyLicense, type PolicyRejection, type RequestExtensions, type TrialContext, type TrialDecision,
} from '../licensing/entitlement-policy.js';
/** Fork trial-duration helper. Lives in the fork-reference test kit file (see its header); exported per the 2.2 contract. */
export { trialDaysForPlatform, type TrialPlatform } from '../licensing/entitlement-policy.fork-reference.testkit.js';
export {
  resolveRuntimeArtifactPromotion,
  type ResolveRuntimeArtifactInput, type RuntimeArtifactDelivery, type RuntimeArtifactResolution, type RuntimeArtifactSelector,
} from '../licensing/runtime-artifact-resolve.js';
export {
  LICENSE_REVOCATION_PERMISSION, restoreLicenseInTx, revokeLicenseInTx,
  type LicenseLifecycleActor, type LicenseRestoreOutcome, type LicenseRevokeOutcome,
} from '../licensing/license-revocation.js';
export { createLicenseRevocationFeed, REVOCATION_FEED_PATH, type RevocationFeedOptions } from '../licensing/revocation-feed.js';
