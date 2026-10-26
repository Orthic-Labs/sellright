import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import type { TrackedOrder } from '~/sellright/types/content';
import { OrderDetails } from './OrderDetails';
import { getLatestPreOrderShipDate } from './order-details-utils';

const order: TrackedOrder = {
  code: 'LABEL', state: 'Paid', displayStatus: 'Processing', placedAt: null, currency: 'USD',
  subtotal: 1000, shippingTotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 1000,
  shippingAddress: null, fulfillments: [], payments: [],
  lines: [{ sku: 'LABEL', name: 'Label fixture', quantity: 1, unitPrice: 1000, lineTotal: 1000,
    isPreOrder: true, shipDate: '2027-01-01T00:00:00Z', shipDateLabel: 'Fall & <script>unsafe()</script>' }],
};

describe('shipping copy rendering', () => {
  it('escapes labels & prefers them over timestamp display without changing date arithmetic', async () => {
    const { document } = await ssrRenderToDom(<OrderDetails order={order} />, {});
    expect(document.body.textContent).toContain('Fall & <script>unsafe()</script>');
    expect(document.body.innerHTML).not.toContain('<script>unsafe()</script>');
    expect(document.body.textContent).not.toContain('January 1, 2027');
    expect(getLatestPreOrderShipDate(order)?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('order summary', () => {
  it('shows discount and tax so the rows add up to the total (#393)', async () => {
    const { document } = await ssrRenderToDom(<OrderDetails order={{ ...order, subtotal: 21940, discountTotal: 2194, shippingTotal: 0, taxTotal: 1810, grandTotal: 21556 }} />, {});
    const text = document.body.textContent ?? '';
    expect(text).toContain('Discount');
    expect(text).toContain('-$21.94');
    expect(text).toContain('Tax');
    expect(text).toContain('$18.10');
  });
});
