import { describe, expect, it } from 'vitest';
import { isPaymentMethodEnabled, isSupportedPaymentMethod, SUPPORTED_PAYMENT_METHODS } from './provider.js';

describe('isPaymentMethodEnabled', () => {
  it('defaults manual and cod on when store config is missing', () => {
    expect(isPaymentMethodEnabled(null, 'manual')).toBe(true);
    expect(isPaymentMethodEnabled(undefined, 'cod')).toBe(true);
  });

  it('honors explicit store payment toggles', () => {
    expect(isPaymentMethodEnabled({ payments: { cod: false, manual: true } }, 'cod')).toBe(false);
    expect(isPaymentMethodEnabled({ payments: { cod: false, manual: true } }, 'manual')).toBe(true);
  });

  it('does not implicitly enable real gateways before credentials/config exist', () => {
    expect(isPaymentMethodEnabled({}, 'stripe')).toBe(false);
    expect(isPaymentMethodEnabled({ payments: { stripe: true } }, 'stripe')).toBe(true);
  });

  it('does not treat unsupported persisted gateway toggles as enabled', () => {
    expect(SUPPORTED_PAYMENT_METHODS).toEqual(['manual', 'cod', 'stripe']);
    expect(isSupportedPaymentMethod('paypal')).toBe(false);
    expect(isPaymentMethodEnabled({ payments: { paypal: true, nmi: true, sezzle: true } }, 'paypal')).toBe(false);
  });
});
