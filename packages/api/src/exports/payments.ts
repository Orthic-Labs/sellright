/**
 * `@sellright/api/payments` — payment policy registrar and hook types (PAYMENT-TIMING.md §3).
 * Register from a plugin's `services` or `init`, never at import time.
 */
export {
  PAYMENT_POLICY_VETO_CODE, PaymentPolicyUnavailableError, PaymentPolicyVetoError, registerPaymentPolicy,
} from '../payments/policy/host.js';
export type {
  BeforeCaptureInput, BeforeCaptureResult, BeforePaymentAttemptInput, BeforePaymentAttemptResult,
  PaymentPolicy, PaymentProvider, PaymentPurpose, PolicyOrder, PolicyVeto,
} from '../payments/policy/types.js';
