import { describe, expect, it } from 'vitest';
import { itemsCopy } from './orders-helpers';

describe('#406 Items cell', () => {
  it.each([
    [{ openQty: 2, shippedQty: 1, removedQty: 0 }, '3 items'],
    [{ openQty: 1, shippedQty: 0 }, '1 item'],
    [{ openQty: 0, shippedQty: 0, removedQty: 2 }, '2 removed'],
    [{ openQty: 0, shippedQty: 1, removedQty: 1 }, '1 item · 1 removed'],
    [{ openQty: undefined, shippedQty: undefined }, '—'],
  ])('%j → %s', (row, want) => { expect(itemsCopy(row)).toBe(want); });
});
