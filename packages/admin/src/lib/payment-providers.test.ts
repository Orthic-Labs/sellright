import { describe, expect, it } from 'vitest';
import { ADMIN_PAYMENT_PROVIDERS } from './payment-providers.js';

describe('ADMIN_PAYMENT_PROVIDERS', () => {
  it('lists only providers implemented by the SellRight payment runtime', () => {
    expect(ADMIN_PAYMENT_PROVIDERS).toEqual(['manual', 'cod', 'stripe']);
    expect(ADMIN_PAYMENT_PROVIDERS).not.toContain('paypal');
    expect(ADMIN_PAYMENT_PROVIDERS).not.toContain('nmi');
    expect(ADMIN_PAYMENT_PROVIDERS).not.toContain('sezzle');
  });
});
