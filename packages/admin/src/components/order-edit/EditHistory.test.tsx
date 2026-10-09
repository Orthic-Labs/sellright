// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { FakeApiError } = vi.hoisted(() => ({ FakeApiError: class extends Error { code?: string; constructor(public status: number, m: string) { super(m); } } }));
const history = [
  { id: 'e1', actor: 'a', reason: null, balance: -500, createdAt: '2026-10-01T00:00:00Z', grandTotalBefore: 2000, grandTotalAfter: 1500, settlement: { type: 'refund_now', status: 'failed', message: 'declined' } },
  { id: 'e2', actor: 'a', reason: null, balance: -500, createdAt: '2026-10-02T00:00:00Z', grandTotalBefore: 2000, grandTotalAfter: 1500, settlement: { type: 'refund_now', status: 'pending' } },
  { id: 'e3', actor: 'a', reason: null, balance: 0, createdAt: '2026-10-03T00:00:00Z', grandTotalBefore: 2000, grandTotalAfter: 2000, settlement: null },
];
const get = vi.fn(async (_p: string) => ({ history }));
const post = vi.fn(async (_p: string, _b?: unknown): Promise<unknown> => ({ settlement: { status: 'settled' } }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b) }, ApiError: FakeApiError }));
vi.mock('../Toast', () => ({ useToast: () => toast }));
vi.mock('../ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: async () => true, dialog: null }) }));

import { EditHistory } from './EditHistory';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
afterEach(() => { document.body.innerHTML = ''; get.mockClear(); post.mockClear(); toast.success.mockClear(); toast.error.mockClear(); });
const pays = [{ id: 'p1', method: 'stripe', amount: 1000, state: 'Settled' }];
async function mount(payments = pays, onChanged = () => {}) {
  const el = document.createElement('div'); document.body.appendChild(el);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={qc}><EditHistory code="X" currency="USD" payments={payments} onChanged={onChanged} /></QueryClientProvider>); });
  await flush();
  return el;
}
const btn = (el: HTMLElement, t: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;

describe('EditHistory', () => {
  it('shows recovery buttons only for failed refunds', async () => {
    const el = await mount();
    expect(el.textContent).toContain('Refund failed');
    expect(el.querySelectorAll('button').length).toBe(2);
    expect(el.querySelector('[data-testid="edit-e1"]')!.querySelectorAll('button').length).toBe(2);
    expect(el.querySelector('[data-testid="edit-e2"]')!.querySelectorAll('button').length).toBe(0);
    expect(el.querySelector('[data-testid="edit-e3"]')!.querySelectorAll('button').length).toBe(0);
    expect(el.querySelector('select')).toBeNull();
  });
  it('retry posts to the refund route and refetches', async () => {
    const onChanged = vi.fn();
    const el = await mount([...pays, { id: 'p2', method: 'paypal', amount: 500, state: 'Settled' }], onChanged);
    const sel = el.querySelector('select') as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, 'p2'); sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { btn(el, 'Retry refund')!.click(); });
    await flush();
    expect(post).toHaveBeenCalledWith('/orders/X/edit/e1/refund', { action: 'retry', paymentId: 'p2' });
    expect(toast.success).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });
  it('credit posts action credit', async () => {
    const el = await mount();
    await act(async () => { btn(el, 'Keep as store credit')!.click(); });
    await flush();
    expect(post).toHaveBeenCalledWith('/orders/X/edit/e1/refund', { action: 'credit' });
  });
  it('shows REFUND_NOT_RETRYABLE message', async () => {
    post.mockRejectedValueOnce(Object.assign(new FakeApiError(409, 'this edit has no failed refund to recover'), { code: 'REFUND_NOT_RETRYABLE' }));
    const el = await mount();
    await act(async () => { btn(el, 'Retry refund')!.click(); });
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Retry failed', 'this edit has no failed refund to recover');
  });
});
