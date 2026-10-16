import { describe, expect, it } from 'vitest';
import { DASHBOARD_PAID_ORDERS_HREF, DASHBOARD_TO_FULFILL_HREF } from './Dashboard.js';
import { filtersFromParams } from '../lib/order-status.js';

describe('Dashboard order links', () => {
  it('opens canonical paid, unfulfilled, active filters for To fulfill', () => {
    const filters = filtersFromParams(new URLSearchParams(DASHBOARD_TO_FULFILL_HREF.split('?')[1]));
    expect(filters).toMatchObject({ paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled', status: 'active', excludeDemo: true });
  });

  it('opens the canonical paid filter for Paid orders', () => {
    const filters = filtersFromParams(new URLSearchParams(DASHBOARD_PAID_ORDERS_HREF.split('?')[1]));
    expect(filters.paymentStatus).toBe('paid');
  });
});
