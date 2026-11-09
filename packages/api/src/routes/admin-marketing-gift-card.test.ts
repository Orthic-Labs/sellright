import { describe, expect, it } from 'vitest';
import { applyGiftCardAdjust } from './admin-marketing-gift-card.js';

describe('applyGiftCardAdjust', () => {
  it('3000 with -5000 clamps to 0 and the ledger delta is -3000', () => {
    expect(applyGiftCardAdjust(3000, -5000)).toEqual({ balance: 0, appliedDelta: -3000 });
  });
  it('5000 with +1000 -> 6000, delta +1000', () => {
    expect(applyGiftCardAdjust(5000, 1000)).toEqual({ balance: 6000, appliedDelta: 1000 });
  });
  it('0 with -100 -> 0, delta 0 (nothing to log)', () => {
    expect(applyGiftCardAdjust(0, -100)).toEqual({ balance: 0, appliedDelta: 0 });
  });
  it('exact drain 2500 with -2500 -> 0, delta -2500', () => {
    expect(applyGiftCardAdjust(2500, -2500)).toEqual({ balance: 0, appliedDelta: -2500 });
  });
});
