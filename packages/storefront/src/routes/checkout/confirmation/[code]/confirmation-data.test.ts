import { describe, expect, it, vi } from 'vitest';
vi.mock('~/utils/seo', () => ({ createSEOHead: vi.fn() }));
import { activeStepFromState, parseLineName } from './confirmation-data';

describe('SellRight confirmation progress', () => {
  it.each([
    ['PendingPayment', 0], ['Paid', 1], ['Shipped', 2], ['Delivered', 3],
    ['PaymentSettled', 1], ['PaymentAuthorized', 1],
  ])('maps %s to the correct step', (state, step) => {
    expect(activeStepFromState(state as string)).toBe(step);
  });
});

describe('parseLineName', () => {
  it('splits "<Product> / <Option>" without a stray trailing separator', () => {
    expect(parseLineName('Studio Notebook / Sage')).toEqual({ productName: 'Studio Notebook', variantLabel: 'Sage' });
  });

  it('joins multiple option segments back with " / "', () => {
    expect(parseLineName('Desk Tray / Rose / Large')).toEqual({ productName: 'Desk Tray', variantLabel: 'Rose / Large' });
  });

  it('falls back to the full variant name when there is no separator', () => {
    expect(parseLineName('Stoneware Cup')).toEqual({ productName: 'Stoneware Cup', variantLabel: '' });
  });

  it('prefers a known product name and skips the split entirely', () => {
    expect(parseLineName('Studio Notebook / Sage', 'Studio Notebook')).toEqual({ productName: 'Studio Notebook', variantLabel: '' });
  });

  it('falls back to "Product" for an empty variant name', () => {
    expect(parseLineName('')).toEqual({ productName: 'Product', variantLabel: '' });
  });
});
