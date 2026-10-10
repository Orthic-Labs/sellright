/**
 * Consumer proof for the policy registrar exports. Each subpath import below must resolve from the
 * PACKED `@sellright/api` tarball; `policyRegistrars` is read by the packed gate (test/boot.mjs).
 * Registration itself happens only in a plugin's `services`/`init`, never at import time.
 */
import { registerLockPlanContributor, registerStoreKitPolicy, type StoreKitPolicy } from '@sellright/api/storekit';
import {
  createLicenseRevocationFeed, registerEntitlementPolicy, resolveRuntimeArtifactPromotion, restoreLicenseInTx, revokeLicenseInTx,
  trialDaysForPlatform, type EntitlementPolicy,
} from '@sellright/api/licensing';
import { registerPaymentPolicy, type BeforeCaptureResult, type PaymentPolicy } from '@sellright/api/payments';
import type { ReleaseRegistrationPolicy } from '@sellright/api/http';

export const policyRegistrars = {
  registerStoreKitPolicy,
  registerLockPlanContributor,
  registerEntitlementPolicy,
  registerPaymentPolicy,
  trialDaysForPlatform,
  resolveRuntimeArtifactPromotion,
  revokeLicenseInTx,
  restoreLicenseInTx,
  createLicenseRevocationFeed,
} as const;

/** Type-level proof: each public policy type is nameable from its subpath. */
export type PolicyTypeProof = {
  storeKit: StoreKitPolicy;
  entitlement: EntitlementPolicy;
  payment: PaymentPolicy;
  capture: BeforeCaptureResult;
  release: ReleaseRegistrationPolicy;
};
