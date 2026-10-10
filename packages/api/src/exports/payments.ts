/**
 * `@sellright/api/payments` — payment policy registrar and hook types (PAYMENT-TIMING.md §3).
 * Register from a plugin's `services` or `init`, never at import time.
 */
export {
  PAYMENT_POLICY_VETO_CODE, PaymentPolicyCompositionError, PaymentPolicyUnavailableError, PaymentPolicyVetoError, registerPaymentPolicy,
} from '../payments/policy/host.js';
export type { ReservationRow } from '../payments/reservation.js';
export type {
  AuthorizeInvoiceEffectInput, BeforeCaptureInput, BeforeCaptureResult, BeforePaymentAttemptInput,
  BeforePaymentAttemptResult, CheckoutExtensionSchema, CheckoutLine, CheckoutOrderInput, CheckoutOrderResult,
  CheckoutPriceAdjustment, CheckoutReplayInput, InvoiceCycle, InvoiceEffectDecision, PaymentPolicy, PaymentProvider,
  PaymentPurpose, PolicyCustomer, PolicyOrder, PolicyVeto, ReservationRequest, EntitlementReversalInput,
  EntitlementReversalReason,
  ReservationTransition, RevalidateForIssuanceInput, RevalidateForIssuanceResult, SettlementResponseInput, SettlementResponseOverride,
} from '../payments/policy/types.js';
