// @vitest-environment jsdom
// Multi-tender refunds must be selectable, and stock reads must never be cached or debounced.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { refundSelection } from './ops';

const CTX = {
  editable: { items: true },
  lines: [{ id: 'l1', sku: 'A-1', name: 'Alpha', quantity: 2, unitPrice: 1000, lineTotal: 2000, fulfilledQty: 0, refundedQty: 0, minQuantity: 0 }],
  shipping: { amount: 0, override: false }, shippingMethods: [], adjustments: [],
};
const totals = { subtotal: 1000, discountTotal: 0, shippingTotal: 0, taxTotal: 0, adjustmentTotal: 0, grandTotal: 1000 };
const PREVIEW = {
  code: 'X', state: 'Paid', currency: 'USD', before: { ...totals, grandTotal: 2000 }, after: totals, lines: [], adjustments: [],
  shipping: { amount: 0, override: false, methodCode: null, methodName: null }, promotion: null, stock: [], stockOk: true,
  balance: { newGrandTotal: 1000, settled: 2000, refunded: 0, netPaid: 2000, editRefunded: 0, amountDue: -1000 },
  settlementOptions: ['refund_now', 'leave_credit'],
  refund: { feasible: false, reason: 'select which payment to refund', payments: [
    { id: 'p1', method: 'stripe', amount: 1200, available: 1200 }, { id: 'p2', method: 'paypal', amount: 800, available: 800 },
  ] },
  warnings: [], address: { shipping: { changed: false, countryChanged: false }, billing: { changed: false } }, isPreOrder: false, recipientEmail: 'a@b.c',
};
const get = vi.fn(async (_p: string) => CTX);
const post = vi.fn(async (_p: string, _b?: unknown) => PREVIEW);
vi.mock('../../api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b) }, ApiError: class extends Error {} }));
vi.mock('../Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { OrderEditPanel } from './OrderEditPanel';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
afterEach(() => { document.body.innerHTML = ''; get.mockClear(); post.mockClear(); });

async function mount(qc: QueryClient) {
  const el = document.createElement('div'); document.body.appendChild(el);
  await act(async () => { createRoot(el).render(<QueryClientProvider client={qc}><OrderEditPanel code="X" currency="USD" onClose={() => {}} onCommitted={() => {}} /></QueryClientProvider>); });
  await flush();
}
function setInput(el: HTMLInputElement, v: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('refundSelection', () => {
  const refund = { feasible: false, reason: 'select which payment to refund', payments: [{ id: 'p1', available: 1200 }, { id: 'p2', available: 800 }] };
  it('is selectable but not ok until a payment with enough capacity is chosen', () => {
    expect(refundSelection(refund, 1000, '')).toMatchObject({ selectable: true, ok: false });
    expect(refundSelection(refund, 1000, 'p1')).toMatchObject({ selectable: true, ok: true });
    expect(refundSelection(refund, 900, 'p2')).toMatchObject({ ok: false, reason: expect.stringContaining('exceeds') });
    expect(refundSelection(refund, 800, 'p2')).toMatchObject({ ok: false });
    expect(refundSelection(refund, 100, 'nope')).toMatchObject({ ok: false });
  });
  it('stays blocked for non-selection reasons', () => {
    expect(refundSelection({ ...refund, reason: 'only a paid order can be refunded' }, 100, 'p1')).toMatchObject({ selectable: false, ok: false });
  });
});

describe('OrderEditPanel', () => {
  it('lets the operator pick the tender for a multi-payment refund and gates commit on its capacity', async () => {
    await mount(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    const qty = document.querySelector<HTMLInputElement>('input[aria-label="Quantity of A-1"]')!;
    await act(async () => { setInput(qty, '1'); }); await flush();
    const radio = [...document.querySelectorAll<HTMLInputElement>('input[name=settlement]')].find((r) => r.parentElement!.textContent!.includes('Refund'))!;
    expect(radio.disabled).toBe(false);
    await act(async () => { radio.click(); }); await flush();
    const commit = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Commit changes')!;
    expect(commit.disabled).toBe(true);
    const sel = document.querySelector<HTMLSelectElement>('select[aria-label="Refund to payment"]')!;
    expect(sel).toBeTruthy();
    await act(async () => { sel.value = 'p2'; sel.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(commit.disabled).toBe(true); // 1000 > 800 available
    await act(async () => { sel.value = 'p1'; sel.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(commit.disabled).toBe(false);
  });

  it('reads stock with staleTime 0 / gcTime 0 and no debounce', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
    await mount(qc);
    const qty = document.querySelector<HTMLInputElement>('input[aria-label="Quantity of A-1"]')!;
    await act(async () => { setInput(qty, '1'); });
    await act(async () => { await Promise.resolve(); });
    expect(post).toHaveBeenCalledTimes(1); // fired immediately, not after a debounce window
    await flush();
    const q = qc.getQueryCache().findAll({ queryKey: ['order-edit-preview'] })[0]!;
    expect((q.options as { staleTime?: number }).staleTime).toBe(0);
    expect((q.options as { gcTime?: number }).gcTime).toBe(0);
  });
});
