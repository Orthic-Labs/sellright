// @vitest-environment jsdom
// The waitlist report page re-queries with the chosen sort / grouping / range
// and downloads the CSV for exactly the current view.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const REPORT = {
  groupBy: 'variant', range: { from: null, to: null }, truncated: false,
  summary: { pending: 4, notified: 1, canceled: 0, unconfirmed: 0, legacyClosed: 0, total: 5, products: 1, variants: 2 },
  rows: [
    { key: 'v1', productName: 'Alpha Knife', productSlug: 'alpha', variantName: 'Black', sku: 'A-1', available: 0, variants: 1, pending: 3, notified: 1, canceled: 0, unconfirmed: 0, legacyClosed: 0, total: 4, lastSignupAt: '2026-10-01T00:00:00Z', oldestPendingAt: '2026-09-01T00:00:00Z' },
    { key: 'v2', productName: 'Alpha Knife', productSlug: 'alpha', variantName: 'Green', sku: 'A-2', available: 4, variants: 1, pending: 1, notified: 0, canceled: 0, unconfirmed: 0, legacyClosed: 0, total: 1, lastSignupAt: null, oldestPendingAt: null },
  ],
};
const get = vi.fn(async (_p: string) => REPORT);
const downloadFile = vi.fn(async (_p: string, _n: string) => undefined);
vi.mock('../api', () => ({ api: { get: (p: string) => get(p) }, downloadFile: (p: string, n: string) => downloadFile(p, n) }));
vi.mock('../auth', () => ({ useAuth: () => ({ store: { slug: 'dd', currency: 'USD' } }) }));
vi.mock('../components/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import Waitlist from './Waitlist';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
afterEach(() => { document.body.innerHTML = ''; get.mockClear(); downloadFile.mockClear(); });

async function mount() {
  const el = document.createElement('div'); document.body.appendChild(el);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={qc}><Waitlist /></QueryClientProvider>); });
  await flush();
}
const byText = (sel: string, text: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text))!;

describe('Waitlist demand page', () => {
  it('loads sorted by waiting-now and shows pending vs notified per variant', async () => {
    await mount();
    expect(get.mock.calls[0]![0]).toBe('/waitlist/report?groupBy=variant&sort=pending&dir=desc');
    expect(document.body.textContent).toContain('A-1');
    expect(document.body.textContent).toContain('out'); // out-of-stock marker for A-1
  });

  it('reads stock live: staleTime 0 and gcTime 0 despite a long client default', async () => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
    await act(async () => { createRoot(el).render(<QueryClientProvider client={qc}><Waitlist /></QueryClientProvider>); });
    await flush();
    const q = qc.getQueryCache().findAll({ queryKey: ['waitlist'] })[0]!;
    expect((q.options as { staleTime?: number }).staleTime).toBe(0);
    expect((q.options as { gcTime?: number }).gcTime).toBe(0);
  });

  it('clicking a header re-sorts; clicking again flips direction', async () => {
    await mount();
    await act(async () => { byText('th button', 'Total').click(); }); await flush();
    expect(get.mock.calls.at(-1)![0]).toBe('/waitlist/report?groupBy=variant&sort=total&dir=desc');
    await act(async () => { byText('th button', 'Total').click(); }); await flush();
    expect(get.mock.calls.at(-1)![0]).toBe('/waitlist/report?groupBy=variant&sort=total&dir=asc');
  });

  it('downloads the CSV for the current view', async () => {
    await mount();
    await act(async () => { byText('button', 'Download CSV').click(); }); await flush();
    expect(downloadFile).toHaveBeenCalledWith('/waitlist/report.csv?groupBy=variant&sort=pending&dir=desc', 'waitlist-demand-dd-variant.csv');
  });
});
