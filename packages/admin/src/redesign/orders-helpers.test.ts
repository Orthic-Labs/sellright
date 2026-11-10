import { describe, expect, it } from 'vitest';
import { itemsCopy, shipsLaterPill } from './orders-helpers';

describe('#406 Items cell', () => {
  it.each([
    [{ openQty: 2, shippedQty: 1, removedQty: 0 }, '3 items'],
    [{ openQty: 1, shippedQty: 0 }, '1 item'],
    [{ openQty: 0, shippedQty: 0, removedQty: 2 }, '2 removed'],
    [{ openQty: 0, shippedQty: 1, removedQty: 1 }, '1 item · 1 removed'],
    [{ openQty: undefined, shippedQty: undefined }, '—'],
  ])('%j → %s', (row, want) => { expect(itemsCopy(row)).toBe(want); });
});

describe('#446 list marker', () => {
  it('only orders with a backorder line get the Ships later pill', () => {
    expect(shipsLaterPill({ hasBackorder: true })).toEqual({ tone: 'info', label: 'Ships later' });
    expect(shipsLaterPill({ hasBackorder: false })).toBeNull();
    expect(shipsLaterPill({})).toBeNull();
  });
});
