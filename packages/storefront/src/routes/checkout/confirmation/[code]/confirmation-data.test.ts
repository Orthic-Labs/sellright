import { describe, expect, it, vi } from 'vitest';
vi.mock('~/utils/seo', () => ({ createSEOHead: vi.fn() }));
import { activeStepFromState } from './confirmation-data';

describe('SellRight confirmation progress', () => {
  it.each([
    ['PendingPayment', 0], ['Paid', 1], ['Shipped', 2], ['Delivered', 3],
    ['PaymentSettled', 1], ['PaymentAuthorized', 1],
  ])('maps %s to the correct step', (state, step) => {
    expect(activeStepFromState(state as string)).toBe(step);
  });
});
