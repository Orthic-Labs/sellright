import { describe, expect, it, vi } from 'vitest';
vi.mock('~/utils/seo', () => ({ createSEOHead: vi.fn() }));
import { activeStepFromState, parseLineName, isOrderSettled, isOrderTerminalUnpaid } from './confirmation-data';

describe('SellRight confirmation progress', () => {
  it.each([
    ['PendingPayment', 0], ['Paid', 1], ['Shipped', 2], ['PartiallyShipped', 2], ['Delivered', 3],
    ['Cancelled', 0], ['Declined', 0], ['AddingItems', 0], [undefined, 0],
  ])('maps %s to the correct step', (state, step) => {
    expect(activeStepFromState(state as string | undefined)).toBe(step);
  });
});

describe('isOrderSettled', () => {
  it.each([
    ['Paid', true], ['Shipped', true], ['PartiallyShipped', true], ['Delivered', true],
    ['PendingPayment', false], ['Cancelled', false], ['Declined', false], ['AddingItems', false], [undefined, false],
  ])('%s → %s', (state, expected) => {
    expect(isOrderSettled(state as string | undefined)).toBe(expected);
  });
});

describe('isOrderTerminalUnpaid', () => {
  it.each([
    ['Cancelled', true], ['Declined', true],
    ['Paid', false], ['PendingPayment', false], ['Shipped', false], [undefined, false],
  ])('%s → %s', (state, expected) => {
    expect(isOrderTerminalUnpaid(state as string | undefined)).toBe(expected);
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
