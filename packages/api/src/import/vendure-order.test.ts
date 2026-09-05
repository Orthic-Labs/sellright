import { describe, expect, it } from 'vitest';
import { mapVendureOrderState, mapVendurePaymentState } from './vendure-order.js';

describe('mapVendureOrderState', () => {
  it.each(['PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered'])('%s maps to Paid', (state) => {
    expect(mapVendureOrderState(state)).toBe('Paid');
  });

  it('preserves cancellation and refund lifecycle states', () => {
    expect(mapVendureOrderState('Cancelled')).toBe('Cancelled');
    expect(mapVendureOrderState('PartiallyRefunded')).toBe('PartiallyRefunded');
    expect(mapVendureOrderState('Refunded')).toBe('Refunded');
  });

  it('does not treat authorization as captured money', () => {
    expect(mapVendureOrderState('PaymentAuthorized')).toBe('PendingPayment');
  });

  it('fails closed for unknown/custom states', () => {
    expect(mapVendureOrderState('AwaitingFraudReview')).toBe('PendingPayment');
  });
});

describe('mapVendurePaymentState', () => {
  it('preserves known payment states and fails closed for unknown ones', () => {
    expect(mapVendurePaymentState('Settled')).toBe('Settled');
    expect(mapVendurePaymentState('Authorized')).toBe('Authorized');
    expect(mapVendurePaymentState('Declined')).toBe('Declined');
    expect(mapVendurePaymentState('Error')).toBe('Failed');
    expect(mapVendurePaymentState('Cancelled')).toBe('Failed');
    expect(mapVendurePaymentState('CustomState')).toBe('Pending');
  });
});
