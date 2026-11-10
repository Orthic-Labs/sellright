import { describe, expect, it } from 'vitest';
import { eventCopy, hasBackorder, isBackorder, shipsLaterCopy, stateCopy } from './order-model';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const ev = (action: string, fromState: string | null, toState: string | null, data?: Record<string, unknown>, actor: string | null = 'staff@shop.test') =>
  eventCopy({ action, fromState, toState, data, actor }, money);

describe('#406 timeline copy: no raw state names', () => {
  it.each([
    [ev('refund', 'Paid', 'PartiallyRefunded', { amount: 2000 }), 'Refunded $20.00 · order now partly refunded'],
    [ev('refund', 'Paid', 'Paid', { amount: 500 }), 'Refunded $5.00'],
    [ev('refund', 'PartiallyRefunded', 'Refunded'), 'Refund issued · order now fully refunded'],
    [ev('draft_create', null, 'Paid'), 'Order created by staff · order now paid'],
    [ev('fulfill', null, 'Shipped'), 'Order shipped'],
    [ev('fulfill', null, 'Shipped', { partial: true }), 'Items shipped · order now shipped'],
    [ev('fulfill', null, 'PartiallyShipped', { partial: true }), 'Items shipped · order now partly shipped'],
    [ev('cancel', 'PendingPayment', 'Cancelled', undefined, 'system:reservation-expiry'), 'Order cancelled · payment wasn’t completed in time'],
    [ev('cancel', 'Paid', 'Cancelled'), 'Order cancelled'],
    [ev('auto_delivered', null, 'Delivered'), 'Marked delivered automatically'],
    [ev('tracking_import', null, 'Shipped', { carrier: 'USPS' }), 'Tracking added from an import · USPS · order now shipped'],
    [ev('some_new_action', 'Paid', 'PartiallyShipped'), 'Some new action · order now partly shipped'],
  ])('%s', (got, want) => { expect(got).toBe(want); });

  it('never shows a CamelCase state, even an unknown one', () => {
    expect(stateCopy('AwaitingReview')).toBe('awaiting review');
    expect(ev('state_correction', 'PartiallyRefunded', 'Refunded')).not.toMatch(/[a-z][A-Z]|→/);
  });
});

describe('#446 ships later', () => {
  it('copy carries the label when there is one', () => {
    expect(shipsLaterCopy({ shipLabel: 'Ships in 3 weeks' })).toBe('Ships later · Ships in 3 weeks');
    expect(shipsLaterCopy({ shipLabel: null })).toBe('Ships later');
    expect(shipsLaterCopy({ shipLabel: '  ' })).toBe('Ships later');
  });
  it('an order has a backorder from the API flag or any marked line', () => {
    expect(hasBackorder({ lines: [{ backorder: false }, {}] })).toBe(false);
    expect(hasBackorder({ lines: [{ backorder: true }] })).toBe(true);
    expect(hasBackorder({ hasBackorder: true, lines: [] })).toBe(true);
    expect(isBackorder({ backorder: true })).toBe(true);
  });
});
