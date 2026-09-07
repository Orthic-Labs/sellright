import { describe, it, expect } from 'vitest';
import { prepareSezzleSession } from './session-input.js';
import type { GatewayAccount } from './gateway-account.js';

const account: GatewayAccount = { accountId: 'dd-sezzle', storeId: 'dd', method: 'sezzle', mode: 'test' };
const order = {
  code: 'DD1', receiptToken: 'receipt', currency: 'USD', grandTotal: 1100, subtotal: 1000,
  discountTotal: 0, shippingTotal: 100, taxTotal: 100,
  metadata: { contact: { email: 'guest@example.com' } }, shippingAddress: { line1: '1 Main', country: 'US' },
  billingAddress: null,
};
const base = { order, account, amount: 1100, attemptId: 'attempt',
  storefrontUrl: 'https://example.com',
  lines: [{ variantName: 'Product', variantSku: 'sku', quantity: 2, unitPrice: 500 }] };

describe('Sezzle session preflight', () => {
  it('supports a new guest without registering an account', () => {
    const result = prepareSezzleSession(base);
    expect(result.customer.email).toBe('guest@example.com');
    expect(result.customer.shipping_address).toMatchObject({ street: '1 Main', country_code: 'US' });
    expect(new URL(result.completeUrl).searchParams.get('rt')).toBe('receipt');
  });
  it('does not add inclusive tax twice', () => {
    expect(prepareSezzleSession(base).tax).toBe(0);
  });
  it('adds exclusive tax preserved in the order', () => {
    const result = prepareSezzleSession({ ...base, amount: 1200, order: { ...order, grandTotal: 1200 } });
    expect(result.tax).toBe(100);
  });
  it('deducts already settled tender from the requested charge', () => {
    expect(prepareSezzleSession({ ...base, amount: 800 }).discount).toBe(300);
  });
  it('rejects missing contact before external I/O', () => {
    expect(() => prepareSezzleSession({ ...base, order: { ...order, metadata: null } })).toThrow('email');
  });
  it('rejects unreconciled totals before external I/O', () => {
    expect(() => prepareSezzleSession({ ...base, order: { ...order, grandTotal: 1137 } })).toThrow('reconcile');
  });
  it('rejects insecure production and credential-bearing return URLs', () => {
    for (const storefrontUrl of ['http://example.com', 'https://user:password@example.com']) {
      expect(() => prepareSezzleSession({ ...base, storefrontUrl })).toThrow('URL');
    }
  });
});
