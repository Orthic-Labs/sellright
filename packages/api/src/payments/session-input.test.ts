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
    expect(() => prepareSezzleSession({ ...base, order: { ...order, grandTotal: 1237 } })).toThrow('reconcile');
  });
  it('rejects insecure production and credential-bearing return URLs', () => {
    for (const storefrontUrl of ['http://example.com', 'https://user:password@example.com']) {
      expect(() => prepareSezzleSession({ ...base, storefrontUrl })).toThrow('URL');
    }
  });
  it('edited order: drops zero-quantity lines and represents positive adjustment + prior payment', () => {
    // $10 line kept, $20 line removed (qty 0), +$5 adjustment, shipping 0, total 1500, $10 already paid
    const edited = { ...order, subtotal: 1000, shippingTotal: 0, taxTotal: 0, grandTotal: 1500 };
    const r = prepareSezzleSession({ ...base, order: edited, amount: 500,
      lines: [{ variantName: 'A', variantSku: 'a', quantity: 1, unitPrice: 1000 }, { variantName: 'B', variantSku: 'b', quantity: 0, unitPrice: 2000 }],
      adjustments: [{ label: 'Rush', amount: 500 }], balance: true });
    const total = r.items.reduce((n, i) => n + i.price.amount_in_cents * i.quantity, 0) + r.shipping + r.tax - r.discount;
    expect(r.items).toHaveLength(2);
    expect(total).toBe(500);
  });
  it('edited order with a negative adjustment reconciles to the balance', () => {
    const edited = { ...order, subtotal: 1000, shippingTotal: 0, taxTotal: 0, grandTotal: 800 };
    const r = prepareSezzleSession({ ...base, order: edited, amount: 800,
      lines: [{ variantName: 'A', variantSku: 'a', quantity: 1, unitPrice: 1000 }], adjustments: [{ label: 'Goodwill', amount: -200 }] });
    const total = r.items.reduce((n, i) => n + i.price.amount_in_cents * i.quantity, 0) + r.shipping + r.tax - r.discount;
    expect(total).toBe(800);
  });
  it('adjustment-only edited order: removed line + positive adjustment prepares a balance session', () => {
    // $100 line removed (qty 0), +$150 adjustment, $100 already paid -> $50 balance
    const edited = { ...order, subtotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 150 };
    const r = prepareSezzleSession({ ...base, order: edited, amount: 50, balance: true,
      lines: [{ variantName: 'A', variantSku: 'a', quantity: 0, unitPrice: 10000 }], adjustments: [{ label: 'Custom work', amount: 150 }] });
    const total = r.items.reduce((n, i) => n + i.price.amount_in_cents * i.quantity, 0) + r.shipping + r.tax - r.discount;
    expect(r.items).toHaveLength(1);
    expect(total).toBe(50);
  });
  it('still rejects an order with no payable items at all', () => {
    const edited = { ...order, subtotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 100 };
    expect(() => prepareSezzleSession({ ...base, order: edited, amount: 100,
      lines: [{ variantName: 'A', variantSku: 'a', quantity: 0, unitPrice: 1000 }] })).toThrow();
  });
});
