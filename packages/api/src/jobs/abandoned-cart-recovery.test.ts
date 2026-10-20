import { describe, expect, it } from 'vitest';
import { cartRecoveryEnabled } from './abandoned-cart-recovery.js';

describe('cartRecoveryEnabled', () => {
  it('defaults to enabled', () => {
    expect(cartRecoveryEnabled(null)).toBe(true);
    expect(cartRecoveryEnabled({})).toBe(true);
    expect(cartRecoveryEnabled({ marketing: {} })).toBe(true);
    expect(cartRecoveryEnabled({ marketing: { cartRecovery: true } })).toBe(true);
  });
  it('only an explicit false opts out', () => {
    expect(cartRecoveryEnabled({ marketing: { cartRecovery: false } })).toBe(false);
    expect(cartRecoveryEnabled({ marketing: { cartRecovery: 'no' } })).toBe(true);
  });
});
