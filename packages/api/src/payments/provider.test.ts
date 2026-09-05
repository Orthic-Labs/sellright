import { describe, expect, it } from 'vitest';
import { getProvider, isPaymentMethodEnabled, isSupportedPaymentMethod, SUPPORTED_PAYMENT_METHODS } from './provider.js';

describe('isPaymentMethodEnabled', () => {
  it('fails closed when store payment config is missing', () => {
    expect(isPaymentMethodEnabled(null, 'manual')).toBe(false);
    expect(isPaymentMethodEnabled(undefined, 'cod')).toBe(false);
    expect(isPaymentMethodEnabled({}, 'stripe')).toBe(false);
  });

  it('honors explicit store payment toggles for supported methods', () => {
    expect(isPaymentMethodEnabled({ payments: { cod: false, manual: true } }, 'cod')).toBe(false);
    expect(isPaymentMethodEnabled({ payments: { cod: false, manual: true } }, 'manual')).toBe(true);
    expect(isPaymentMethodEnabled({ payments: { stripe: true } }, 'stripe')).toBe(true);
  });

  it('does not treat unsupported persisted gateway toggles as enabled', () => {
    expect(SUPPORTED_PAYMENT_METHODS).toEqual(['manual', 'cod', 'stripe', 'gift_card']);
    expect(isSupportedPaymentMethod('paypal')).toBe(false);
    expect(isPaymentMethodEnabled({ payments: { paypal: true, nmi: true, sezzle: true } }, 'paypal')).toBe(false);
  });
});

describe('shopper settlement safety', () => {
  it.each(['manual', 'cod', 'gift_card'] as const)('%s cannot self-settle through the generic provider', async (method) => {
    const provider = getProvider(method)!;
    const result = await provider.createPayment({ orderCode: 'T-1', amount: 500, currency: 'USD' });
    expect(result.state).toBe('Failed');
    expect(result.providerRef).toBeNull();
  });
});

// Regression: refunding a gift-card-paid order used to report fake success
// while moving zero money back, because 'gift_card' had NO entry in this
// registry — getProvider('gift_card') was null, and
// admin-order-payment-helpers.ts's executeGatewayRefund collapsed "no
// provider" and "provider has nothing to do" into the same silent-success
// branch. A real (no-op) provider must exist so the refund handler can tell
// "gift_card, nothing to call at the gateway" apart from "genuinely
// unsupported method — surface an error".
describe('gift_card provider', () => {
  it('is a registered, supported payment method', () => {
    expect(isSupportedPaymentMethod('gift_card')).toBe(true);
    expect(getProvider('gift_card')).not.toBeNull();
  });

  it('refundPayment is a no-op that reports Settled with no providerRef (no external gateway to call)', async () => {
    const provider = getProvider('gift_card')!;
    expect(provider.refundPayment).toBeDefined();
    const r = await provider.refundPayment!({ providerRef: null, amount: 500, currency: 'USD' });
    expect(r).toEqual({ state: 'Settled', providerRef: null });
  });

  it('a genuinely unsupported method (no provider at all) is still null — the fix only closes the gift_card gap', () => {
    expect(getProvider('paypal')).toBeNull();
    expect(getProvider('nmi')).toBeNull();
  });
});
