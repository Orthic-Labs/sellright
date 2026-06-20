import { describe, expect, it } from 'vitest';
import { refundStateFromStripe, refundTargetState } from './webhook-reconcile.js';

describe('refundStateFromStripe', () => {
  it('maps Stripe refund status → our refund_state enum', () => {
    expect(refundStateFromStripe('succeeded')).toBe('Settled');
    expect(refundStateFromStripe('pending')).toBe('Pending');
    expect(refundStateFromStripe('failed')).toBe('Failed');
    expect(refundStateFromStripe('canceled')).toBe('Failed');
    expect(refundStateFromStripe('requires_action')).toBe('Failed');
  });
});

describe('refundTargetState', () => {
  it('no settled refunds → no transition', () => {
    expect(refundTargetState(0, 10000)).toBeNull();
    expect(refundTargetState(-5, 10000)).toBeNull();
  });
  it('partial refund → PartiallyRefunded', () => {
    expect(refundTargetState(2500, 10000)).toBe('PartiallyRefunded');
    expect(refundTargetState(9999, 10000)).toBe('PartiallyRefunded');
  });
  it('full (or over) refund → Refunded', () => {
    expect(refundTargetState(10000, 10000)).toBe('Refunded');
    expect(refundTargetState(10001, 10000)).toBe('Refunded'); // over-refund still terminal
  });
});
