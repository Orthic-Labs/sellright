/** `@sellright/api/storekit` */
export { deploymentConfigFor, loadStoreKitAppConfig } from '../licensing/storekit-config.js';
export {
  ensureStoreKitLicense, isSandboxStoreKitLicense, issueStoreKitActivation, storeKitLicenseKey, type VerifiedStoreKitLicenseSource,
} from '../licensing/storekit-license.js';
export { verifyStoreKitTransactionForDeployment, type StoreKitTransactionPayload } from '../licensing/storekit-verify.js';
/** Default-policy building blocks a plugin policy composes (STOREKIT §3): proof source mapping and the SellRight response shape. */
export { sellrightRespond, sourceFromTransaction } from '../licensing/storekit/default-policy.js';
export {
  registerStoreKitPolicy,
  type CascadeResult, type Credential, type DecideMaterializeInput, type DeviceContext, type HttpResult, type IssueInput, type IssueResult,
  type LinkOutcome, type LinkRequest, type LinkValidation, type MaterializeDecision, type NotificationChange, type StoreKitPolicy,
  type ValidateLinkInput, type VerifiedProofSet,
} from '../licensing/storekit/policy.js';
/** Lock-plan contributor API (STOREKIT §5.3): a policy adds dependent purchases/licences/orders to a locked subject. */
export {
  registerLockPlanContributor,
  type HeldLocks, type LockPlanContribution, type LockPlanContributor, type LockSubject, type PurchaseId,
} from '../db/locks.js';
