import { describe, it, expect } from 'vitest';
import { applyGiftCard } from './gift-card.js';

const NOW = new Date('2026-06-06T00:00:00Z');

describe('applyGiftCard', () => {
  it('rejects a partial balance without drawing from the card', () => {
    expect(applyGiftCard({ balance: 5000, enabled: true, expiresAt: null }, 12000, NOW))
      .toMatchObject({ applicable: false, reason: 'insufficient_balance', applied: 0, remainingDue: 12000, newBalance: 5000 });
  });
  it('covers the order fully and keeps the leftover balance', () => {
    expect(applyGiftCard({ balance: 12000, enabled: true, expiresAt: null }, 5000, NOW))
      .toMatchObject({ applicable: true, applied: 5000, remainingDue: 0, newBalance: 7000 });
  });
  it('rejects disabled / expired / empty cards without drawing', () => {
    expect(applyGiftCard({ balance: 5000, enabled: false, expiresAt: null }, 1000, NOW)).toMatchObject({ applicable: false, reason: 'disabled', applied: 0 });
    expect(applyGiftCard({ balance: 5000, enabled: true, expiresAt: new Date('2026-06-05T00:00:00Z') }, 1000, NOW)).toMatchObject({ applicable: false, reason: 'expired' });
    expect(applyGiftCard({ balance: 0, enabled: true, expiresAt: null }, 1000, NOW)).toMatchObject({ applicable: false, reason: 'empty' });
  });
});
