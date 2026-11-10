// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../api', () => ({
  ApiError: class ApiError extends Error { code?: string; constructor(public status: number, message: string) { super(message); } },
  api: { get: mocks.get, post: mocks.post },
}));
vi.mock('../auth', () => ({ useAuth: () => ({ store: { slug: 's' } }) }));
vi.mock('../components/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../components/order-edit/AddressCard', () => ({ addressLines: () => ['', '', 'Somewhere'] }));

import { FulfilDialog } from './FulfilDialog';
import { ApiError } from '../api';

const order = {
  code: 'SR-1', state: 'Paid', shippingMethodName: 'Ground', customer: { firstName: 'A', lastName: 'B', email: 'a@b.test' }, contact: null, shippingAddress: null, fulfillments: [],
  lines: [
    { id: 'l1', sku: 'SKU-1', name: 'Mug', quantity: 3, fulfilledQty: 0, cancelledQty: 0, refundedQty: 0, unitPrice: 100, lineTotal: 300, backorder: true, shipLabel: 'Ships in 3 weeks' },
    { id: 'l2', sku: 'SKU-2', name: 'Cup', quantity: 1, fulfilledQty: 0, cancelledQty: 0, refundedQty: 0, unitPrice: 100, lineTotal: 100 },
  ],
};
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  mocks.get.mockReset().mockImplementation(async (path: string) => (path.startsWith('/locations') ? { items: [] } : structuredClone(order)));
  mocks.post.mockReset();
  const el = document.createElement('div'); document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><FulfilDialog code="SR-1" open onClose={() => {}} /></QueryClientProvider>);
  });
  await flush();
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; });

describe('#446 fulfil dialog', () => {
  it('marks a backorder line with Ships later and its label, and no other line', () => {
    const pills = [...document.querySelectorAll('.fl .pill')].map((n) => n.textContent);
    expect(pills).toEqual(['Ships later · Ships in 3 weeks']);
  });

  it('shows the 409 message that names the SKU, and what to do next', async () => {
    mocks.post.mockRejectedValue(Object.assign(new ApiError(409, 'cannot ship 3 x SKU-1: only 1 on hand (the rest is still incoming; receive it first)'), { code: 'INSUFFICIENT_ON_HAND' }));
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Fulfil '))!.click(); });
    await flush();
    const text = document.querySelector('[role="alert"]')?.textContent ?? document.body.textContent;
    expect(text).toContain('Nothing was shipped.');
    expect(text).toContain('cannot ship 3 x SKU-1: only 1 on hand');
    expect(text).toContain('Receive the incoming stock on the product page');
  });
});
