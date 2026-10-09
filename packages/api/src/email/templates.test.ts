/**
 * Unit tests for the PAR-03 refund-confirmation and email-address-change
 * templates — no DB, pure rendering.
 */
import { describe, expect, it } from 'vitest';
import { orderRefundConfirmation, emailAddressChange, pointsEarned, reviewApproved, type StoreCtx } from './templates.js';

const store: StoreCtx = {
  name: 'Brand B',
  currency: 'EUR',
  storefrontUrl: 'https://b-brand.example',
  fromEmail: 'orders@b-brand.example',
};

describe('orderRefundConfirmation (PAR-03)', () => {
  it('renders a partial refund with cumulative vs order totals', () => {
    const m = orderRefundConfirmation(store, { code: 'B-1', amount: 1000, currency: 'EUR', refundedTotal: 1500, grandTotal: 4200 });
    expect(m.subject).toContain('B-1');
    expect(m.html).toContain('10.00 EUR');
    expect(m.html).toContain('Total refunded so far: 15.00 EUR of 42.00 EUR');
    expect(m.html).not.toContain('fully refunds');
    expect(m.html).toContain('https://b-brand.example/orders/B-1');
    expect(m.text).toContain('b-brand.example');
  });

  it('renders a full refund when cumulative refunded covers the order total', () => {
    const m = orderRefundConfirmation(store, { code: 'B-2', amount: 4200, currency: 'EUR', refundedTotal: 4200, grandTotal: 4200 });
    expect(m.html).toContain('42.00 EUR');
    expect(m.html).toContain('fully refunds the order total of 42.00 EUR');
  });

  it('escapes store name and order code in html/subject', () => {
    const s2 = { ...store, name: 'B<ad>' };
    const m = orderRefundConfirmation(s2, { code: 'X<1>', amount: 1, currency: 'EUR', refundedTotal: 1, grandTotal: 1 });
    expect(m.html).not.toContain('<ad>');
    expect(m.html).toContain('B&lt;ad&gt;');
    expect(m.subject).toContain('X<1>'); // subject is plain text — no html escaping
  });
});

describe('emailAddressChange (emailAddressChangeHandler parity)', () => {
  it('points at the new address with the confirm URL', () => {
    const m = emailAddressChange(store, { url: 'https://b-brand.example/verify-email-address-change?token=abc', newEmail: 'new@example.com', ttlHours: 24 });
    expect(m.html).toContain('https://b-brand.example/verify-email-address-change?token=abc');
    expect(m.html).toContain('new@example.com');
    expect(m.html).toContain('24 hours');
    expect(m.subject).toContain('Confirm your new email address');
  });
});

describe('REWARDS-1 templates', () => {
  it('pointsEarned itemizes the posting and states the new balance', () => {
    const m = pointsEarned(store, { points: 600, balance: 1234, lines: [{ label: 'Order B-1', points: 100 }, { label: 'First order bonus', points: 500 }], accountUrl: 'https://b-brand.example/account/rewards' });
    expect(m.subject).toContain('You earned 600 points');
    expect(m.html).toContain('First order bonus');
    expect(m.text).toContain('New balance: 1,234 points');
    expect(m.html).toContain('/account/rewards');
  });
  it('pointsEarned escapes caller-supplied labels', () => {
    expect(pointsEarned(store, { points: 1, balance: 1, lines: [{ label: '<script>x</script>', points: 1 }] }).html).not.toContain('<script>x');
  });
  it('reviewApproved mentions points only when a bonus was granted', () => {
    expect(reviewApproved(store, { productName: 'Knife', points: 50, balance: 150 }).text).toContain('50 points');
    expect(reviewApproved(store, { productName: 'Knife', points: 0, balance: null }).text).not.toContain('points');
    expect(reviewApproved(store, { productName: '<b>Knife</b>', points: 0, balance: null }).html).not.toContain('<b>Knife</b>');
  });
});
