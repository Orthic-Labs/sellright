/**
 * Consumer proof for the policy registrar exports. Each subpath import below must resolve from the
 * PACKED `@sellright/api` tarball; `policyRegistrars` is read by the packed gate (test/boot.mjs).
 * Registration itself happens only in a plugin's `services`/`init`, never at import time.
 */
import {
  issueStoreKitActivation, registerLockPlanContributor, registerStoreKitPolicy, sellrightRespond, sourceFromTransaction, storeKitLicenseKey,
  type StoreKitPolicy, type StoreKitTransactionPayload, type VerifiedStoreKitLicenseSource,
} from '@sellright/api/storekit';
import {
  createLicenseRevocationFeed, registerEntitlementPolicy, resolveRuntimeArtifactPromotion, restoreLicenseInTx, revokeLicenseInTx,
  type EntitlementPolicy,
} from '@sellright/api/licensing';
import {
  registerPaymentPolicy, type BeforeCaptureResult, type CheckoutExtensionSchema, type CheckoutOrderInput, type CheckoutOrderResult,
  type InvoiceEffectDecision, type PaymentPolicy, type ReservationRequest, type RevalidateForIssuanceResult, type SettlementResponseOverride,
} from '@sellright/api/payments';
import type { ReleaseRegistrationPolicy } from '@sellright/api/http';

export const policyRegistrars = {
  registerStoreKitPolicy,
  registerLockPlanContributor,
  issueStoreKitActivation,
  storeKitLicenseKey,
  sellrightRespond,
  sourceFromTransaction,
  registerEntitlementPolicy,
  registerPaymentPolicy,
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
  reservation: ReservationRequest;
  invoiceDecision: InvoiceEffectDecision;
  revalidate: RevalidateForIssuanceResult;
  settlementOverride: SettlementResponseOverride;
  checkoutExtension: CheckoutExtensionSchema;
  checkoutInput: CheckoutOrderInput;
  checkoutResult: CheckoutOrderResult;
  release: ReleaseRegistrationPolicy;
  storeKitSource: VerifiedStoreKitLicenseSource;
  storeKitPayload: StoreKitTransactionPayload;
};
