import { describe, expect, it } from 'vitest';
import { deriveFulfillmentStatus, deriveOrderStatus, derivePaymentStatus, wirePaymentState } from './status.js';

describe('deriveOrderStatus (mirrors the order.status GENERATED column)', () => {
  it('archived wins over everything else when deletedAt is set', () => {
    expect(deriveOrderStatus('Paid', new Date())).toBe('archived');
    expect(deriveOrderStatus('Cancelled', new Date())).toBe('archived');
  });
  it('cancelled', () => expect(deriveOrderStatus('Cancelled', null)).toBe('cancelled'));
  it('open for PendingPayment', () => expect(deriveOrderStatus('PendingPayment', null)).toBe('open'));
  it('completed for Paid/PartiallyRefunded/Refunded', () => {
    expect(deriveOrderStatus('Paid', null)).toBe('completed');
    expect(deriveOrderStatus('PartiallyRefunded', null)).toBe('completed');
    expect(deriveOrderStatus('Refunded', null)).toBe('completed');
  });
});

describe('derivePaymentStatus', () => {
  it('Refunded/PartiallyRefunded/Paid order states map directly, regardless of payment rows', () => {
    expect(derivePaymentStatus('Refunded', [])).toBe('refunded');
    expect(derivePaymentStatus('PartiallyRefunded', [])).toBe('partially_refunded');
    expect(derivePaymentStatus('Paid', [])).toBe('paid');
  });

  describe('PendingPayment — reads the most recent payment row', () => {
    it('no payment attempt yet -> pending', () => expect(derivePaymentStatus('PendingPayment', [])).toBe('pending'));
    it('most recent payment Authorized -> authorized', () =>
      expect(derivePaymentStatus('PendingPayment', [{ state: 'Authorized' }, { state: 'Failed' }])).toBe('authorized'));
    it('most recent payment Declined -> failed', () =>
      expect(derivePaymentStatus('PendingPayment', [{ state: 'Declined' }])).toBe('failed'));
    it('most recent payment Failed -> failed', () =>
      expect(derivePaymentStatus('PendingPayment', [{ state: 'Failed' }])).toBe('failed'));
    it('most recent payment still Pending -> pending', () =>
      expect(derivePaymentStatus('PendingPayment', [{ state: 'Pending' }])).toBe('pending'));
  });

  describe('Cancelled', () => {
    it('no payment ever attempted -> pending', () => expect(derivePaymentStatus('Cancelled', [])).toBe('pending'));
    it('had an Authorized (never captured) payment -> voided', () =>
      expect(derivePaymentStatus('Cancelled', [{ state: 'Authorized' }])).toBe('voided'));
    it('only Declined/Failed attempts -> failed', () =>
      expect(derivePaymentStatus('Cancelled', [{ state: 'Declined' }])).toBe('failed'));
    it('anomaly: a Settled payment survived onto a Cancelled order -> paid (money moved)', () =>
      expect(derivePaymentStatus('Cancelled', [{ state: 'Settled' }])).toBe('paid'));
  });
});

describe('deriveFulfillmentStatus', () => {
  const lines = (over: Partial<{ quantity: number; fulfilledQty: number; cancelledQty: number }>[]) =>
    over.map((l) => ({ quantity: 1, fulfilledQty: 0, cancelledQty: 0, ...l }));

  it('unfulfilled when nothing has shipped', () => {
    expect(deriveFulfillmentStatus(lines([{ quantity: 2 }]), [])).toBe('unfulfilled');
  });
  it('fulfilled — no fulfillment record at all edge case', () => {
    expect(deriveFulfillmentStatus(lines([{ quantity: 2, fulfilledQty: 2 }]), [])).toBe('fulfilled');
  });
  it('fulfilled when shipped and the fulfillment record is Pending/Shipped', () => {
    expect(deriveFulfillmentStatus(lines([{ quantity: 2, fulfilledQty: 2 }]), [{ state: 'Shipped' }])).toBe('fulfilled');
  });
  it('delivered when every active fulfillment record is Delivered', () => {
    expect(deriveFulfillmentStatus(lines([{ quantity: 2, fulfilledQty: 2 }]), [{ state: 'Delivered' }])).toBe('delivered');
  });
  it('partially_fulfilled when some but not all quantity has shipped', () => {
    expect(deriveFulfillmentStatus(lines([{ quantity: 4, fulfilledQty: 1 }]), [])).toBe('partially_fulfilled');
  });
  it('partially_delivered when some (not all) active fulfillments are Delivered', () => {
    const ls = lines([{ quantity: 2, fulfilledQty: 2 }]);
    expect(deriveFulfillmentStatus(ls, [{ state: 'Delivered' }, { state: 'Shipped' }])).toBe('partially_delivered');
  });
  it('a Cancelled fulfillment record is excluded from the active set', () => {
    expect(deriveFulfillmentStatus(lines([{ quantity: 2, fulfilledQty: 2 }]), [{ state: 'Cancelled' }])).toBe('fulfilled');
  });
  it('cancelledQty reduces the denominator — a fully-cancelled line never blocks "fulfilled"', () => {
    expect(deriveFulfillmentStatus(lines([{ quantity: 2, fulfilledQty: 0, cancelledQty: 2 }]), [])).toBe('fulfilled');
  });
});

describe('wirePaymentState', () => {
  it('renames Settled -> captured', () => expect(wirePaymentState('Settled')).toBe('captured'));
  it('lowercases every other known state', () => {
    expect(wirePaymentState('Pending')).toBe('pending');
    expect(wirePaymentState('Authorized')).toBe('authorized');
    expect(wirePaymentState('Declined')).toBe('declined');
    expect(wirePaymentState('Failed')).toBe('failed');
  });
  it('falls back to a plain lowercase for an unrecognized value instead of throwing', () => {
    expect(wirePaymentState('SomethingNew')).toBe('somethingnew');
  });
});
