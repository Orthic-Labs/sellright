// `sellright-default` payment policy: allows every attempt (PAYMENT-TIMING §3.1: a missing
// policy = default policy). SellRight standalone behaviour is unchanged.
import { registerPaymentPolicy, registeredPaymentPolicies } from './host.js';
import type { PaymentPolicy } from './types.js';

export const SELLRIGHT_DEFAULT_POLICY_ID = 'sellright-default';

export const sellrightDefaultPaymentPolicy: PaymentPolicy = {
  id: SELLRIGHT_DEFAULT_POLICY_ID,
  async beforePaymentAttempt() {
    return { allow: true };
  },
  async beforeCapture() {
    return { action: 'capture' };
  },
};

/** Installs sellright-default once. Idempotent; called by createApp() before plugins init. */
export function installDefaultPaymentPolicy(): void {
  if (!registeredPaymentPolicies().some((p) => p.id === SELLRIGHT_DEFAULT_POLICY_ID)) {
    registerPaymentPolicy(sellrightDefaultPaymentPolicy);
  }
}
