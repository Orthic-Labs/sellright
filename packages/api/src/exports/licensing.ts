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
