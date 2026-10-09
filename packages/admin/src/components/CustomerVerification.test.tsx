// @vitest-environment jsdom
// "Clear verification" is offered only when the server says the admin may,
// needs a reason, and posts the chosen scope.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let data: Record<string, unknown>;
const get = vi.fn(async (_p: string) => data);
const post = vi.fn(async (_p: string, _b?: unknown) => ({ cleared: ['student'], rowsRevoked: 1, importedRemoved: 0, active: [] }));
vi.mock('../api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b) } }));
vi.mock('../auth', () => ({ useAuth: () => ({ store: { slug: 'dd', currency: 'USD' } }) }));
vi.mock('./Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { CustomerVerification, reasonOk } from './CustomerVerification';

const base = {
  customerId: 'c1', active: ['student', 'military'], attempts: [], canClear: true, history: [],
  entries: [
    { category: 'student', programId: 'p', discountPercent: 15, verifiedAt: '2026-09-01T00:00:00Z', expiresAt: null, source: 'sheerid' },
    { category: 'military', programId: null, discountPercent: 10, verifiedAt: null, expiresAt: null, source: 'imported' },
  ],
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
afterEach(() => { document.body.innerHTML = ''; get.mockClear(); post.mockClear(); });

async function mount() {
  const el = document.createElement('div'); document.body.appendChild(el);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={qc}><CustomerVerification customerId="c1" /></QueryClientProvider>); });
  await flush();
}
const submitBtn = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'Clear verification')!;
const btn = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.includes(text));
const change = (el: HTMLSelectElement | HTMLTextAreaElement, value: string) => act(async () => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

describe('CustomerVerification', () => {
  it('requires a reason of at least 3 characters', () => {
    expect(reasonOk('')).toBe(false);
    expect(reasonOk('  ab ')).toBe(false);
    expect(reasonOk('fraud')).toBe(true);
  });

  it('hides the action when the admin lacks permission', async () => {
    data = { ...base, canClear: false };
    await mount();
    expect(document.body.textContent).toContain('student');
    expect(btn('Clear verification')).toHaveLength(0);
  });

  it('hides the action when there is nothing to clear', async () => {
    data = { ...base, active: [], entries: [] };
    await mount();
    expect(btn('Clear verification')).toHaveLength(0);
    expect(document.body.textContent).toContain('Not verified');
  });

  it('posts the reason and chosen category', async () => {
    data = base;
    await mount();
    await act(async () => { btn('Clear verification')[0]!.click(); });
    const submit = submitBtn;
    expect(submit().disabled).toBe(true);
    await change(document.getElementById('ver-reason') as HTMLTextAreaElement, 'Wrong person verified');
    expect(submit().disabled).toBe(false);
    await change(document.getElementById('ver-cat') as HTMLSelectElement, 'military');
    await act(async () => { submit().click(); });
    await flush();
    expect(post).toHaveBeenCalledWith('/customers/c1/verification/clear', { reason: 'Wrong person verified', category: 'military' });
  });

  it('clears everything when no category is picked and shows history', async () => {
    data = { ...base, history: [{ action: 'verification_cleared', actor: 'owner@x.test', at: '2026-10-01T00:00:00Z', categories: ['student'], reason: 'fraud' }] };
    await mount();
    expect(document.body.textContent).toContain('Verification cleared');
    expect(document.body.textContent).toContain('fraud');
    await act(async () => { btn('Clear verification')[0]!.click(); });
    await change(document.getElementById('ver-reason') as HTMLTextAreaElement, 'customer request');
    await act(async () => { submitBtn().click(); });
    await flush();
    expect(post).toHaveBeenCalledWith('/customers/c1/verification/clear', { reason: 'customer request' });
  });
});
