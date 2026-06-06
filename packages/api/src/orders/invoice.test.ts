import { describe, it, expect } from 'vitest';
import { buildInvoice, buildPackingSlip, renderInvoiceHtml, type InvoiceOrder, type InvoiceLine } from './invoice.js';

const order: InvoiceOrder = {
  code: 'SR123ABC', currency: 'USD',
  createdAt: new Date('2026-06-01T12:00:00Z'), placedAt: new Date('2026-06-02T09:30:00Z'),
  subtotal: 10000, discountTotal: 1000, shippingTotal: 500, taxTotal: 788, grandTotal: 10288,
  shippingAddress: { fullName: 'Ada L', line1: '1 King St', city: 'London', country: 'GB', postalCode: 'EC1' },
  billingAddress: null,
};
const lines: InvoiceLine[] = [{ variantSku: 'SKU1', variantName: 'Copper Spinner', quantity: 2, unitPrice: 5000, lineTotal: 9000 }];
const store = { name: 'Damned Designs', slug: 'damned' };

describe('invoice builder', () => {
  it('numbers, dates, and formats money', () => {
    const doc = buildInvoice(order, lines, store);
    expect(doc.number).toBe('INV-SR123ABC');
    expect(doc.date).toBe('2026-06-02'); // placedAt wins over createdAt
    expect(doc.totals.grand).toBe('$102.88');
    expect(doc.lines[0]!.unitPrice).toBe('$50.00');
  });
  it('falls back to shipping address when billing is absent', () => {
    const doc = buildInvoice(order, lines, store);
    expect(doc.billTo).toContain('1 King St');
  });
  it('packing slip omits prices', () => {
    const ps = buildPackingSlip(order, lines, store);
    expect(ps.number).toBe('PS-SR123ABC');
    expect(JSON.stringify(ps)).not.toContain('50.00');
    expect(ps.lines[0]!.quantity).toBe(2);
  });
  it('renders escaped HTML', () => {
    const html = renderInvoiceHtml(buildInvoice({ ...order, shippingAddress: { fullName: 'A & <b>B</b>', line1: 'x', city: 'y', country: 'z' } }, lines, store));
    expect(html).toContain('INV-SR123ABC');
    expect(html).toContain('A &amp; &lt;b&gt;');
    expect(html).not.toContain('<b>B</b>');
  });
});
