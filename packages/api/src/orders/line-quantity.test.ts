import { describe, expect, it } from 'vitest';
import { billedLine, billedLines, billedQty, reconcileLineQuantities } from './line-quantity.js';

describe('billed view of a stored order line', () => {
  it('is the row itself when no unit was edit-removed (every row that predates the column)', () => {
    const row = { id: 'l1', quantity: 3, cancelledQty: 1, editRemovedQty: 0 };
    expect(billedLine(row)).toBe(row);
    const legacy = { id: 'l2', quantity: 2, cancelledQty: 0 };
    expect(billedLine(legacy)).toBe(legacy);
    expect(billedQty(legacy)).toBe(2);
  });

  it('hides edit-removed units from quantity and from cancelledQty only', () => {
    const row = { id: 'l1', quantity: 3, cancelledQty: 2, editRemovedQty: 1, fulfilledQty: 1, refundedQty: 1 };
    expect(billedLine(row)).toEqual({ id: 'l1', quantity: 2, cancelledQty: 1, editRemovedQty: 1, fulfilledQty: 1, refundedQty: 1 });
    expect(billedQty(row)).toBe(2);
    expect(billedLines([row])[0]!.quantity).toBe(2);
    // the stored row is never mutated
    expect(row.quantity).toBe(3);
  });
});

describe('reconcileLineQuantities (billed quantity -> stored columns)', () => {
  it('lowering keeps the ordered quantity and cancels + records the removed units', () => {
    expect(reconcileLineQuantities({ quantity: 1, cancelledQty: 0, editRemovedQty: 0 }, 0))
      .toMatchObject({ quantity: 1, cancelledQty: 1, editRemovedQty: 1, removed: 1, restored: 0, added: 0 });
    expect(reconcileLineQuantities({ quantity: 2, cancelledQty: 0, editRemovedQty: 0 }, 1))
      .toMatchObject({ quantity: 2, cancelledQty: 1, editRemovedQty: 1, removed: 1 });
    // refund-cancelled units stay billed and are not touched by a removal
    expect(reconcileLineQuantities({ quantity: 4, cancelledQty: 1, editRemovedQty: 0 }, 2))
      .toMatchObject({ quantity: 4, cancelledQty: 3, editRemovedQty: 2 });
  });

  it('raising un-cancels edit-removed units first, then adds', () => {
    const stored = { quantity: 3, cancelledQty: 2, editRemovedQty: 2 }; // billed 1
    expect(reconcileLineQuantities(stored, 2)).toMatchObject({ quantity: 3, cancelledQty: 1, editRemovedQty: 1, restored: 1, added: 0 });
    expect(reconcileLineQuantities(stored, 3)).toMatchObject({ quantity: 3, cancelledQty: 0, editRemovedQty: 0, restored: 2, added: 0 });
    expect(reconcileLineQuantities(stored, 4)).toMatchObject({ quantity: 4, cancelledQty: 0, editRemovedQty: 0, restored: 2, added: 1 });
  });

  it('never un-cancels units a refund or cancellation cancelled', () => {
    expect(reconcileLineQuantities({ quantity: 3, cancelledQty: 2, editRemovedQty: 0 }, 4))
      .toMatchObject({ quantity: 4, cancelledQty: 2, editRemovedQty: 0, restored: 0, added: 1 });
  });

  it('an unchanged billed quantity changes nothing', () => {
    expect(reconcileLineQuantities({ quantity: 3, cancelledQty: 2, editRemovedQty: 1 }, 2))
      .toEqual({ quantity: 3, cancelledQty: 2, editRemovedQty: 1, removed: 0, restored: 0, added: 0 });
  });

  it('keeps edit_removed_qty <= cancelled_qty <= quantity through any sequence', () => {
    let st = { quantity: 5, cancelledQty: 1, editRemovedQty: 0 };
    for (const billed of [3, 4, 1, 2, 6, 4, 4, 5]) {
      const { quantity, cancelledQty, editRemovedQty } = reconcileLineQuantities(st, billed);
      expect(editRemovedQty).toBeGreaterThanOrEqual(0);
      expect(editRemovedQty).toBeLessThanOrEqual(cancelledQty);
      expect(cancelledQty).toBeLessThanOrEqual(quantity);
      expect(quantity - editRemovedQty).toBe(billed);
      st = { quantity, cancelledQty, editRemovedQty };
    }
  });
});
