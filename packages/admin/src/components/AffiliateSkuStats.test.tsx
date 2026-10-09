// @vitest-environment jsdom
// Range presets and custom dates must be sent to the stats endpoint, and the
// per-SKU table must render units / sales / commission from the response.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const STATS = {
  range: { from: null, to: null }, commissionPct: 10,
  totals: { orders: 2, units: 4, revenue: 14000, commission: 1400 },
  bySku: [{ sku: 'A-1', name: 'Alpha / Black', units: 3, orders: 2, revenue: 10400, commission: 1040 }, { sku: 'A-2', name: 'Alpha / Green', units: 1, orders: 1, revenue: 3600, commission: 360 }],
};
const get = vi.fn(async (_p: string) => STATS);
vi.mock('../api', () => ({ api: { get: (p: string) => get(p) } }));
vi.mock('../auth', () => ({ useAuth: () => ({ store: { slug: 'dd', currency: 'USD' } }) }));

import { AffiliateSkuStats, statsQuery } from './AffiliateSkuStats';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
afterEach(() => { document.body.innerHTML = ''; get.mockClear(); });

async function mount() {
  const el = document.createElement('div'); document.body.appendChild(el);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={qc}><AffiliateSkuStats affiliateId="aff-1" /></QueryClientProvider>); });
  await flush();
}
const change = (el: HTMLSelectElement | HTMLInputElement, value: string) => act(async () => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

describe('statsQuery', () => {
  it('omits blank bounds', () => {
    expect(statsQuery('', '')).toBe('');
    expect(statsQuery('2026-10-01', '')).toBe('?from=2026-10-01');
    expect(statsQuery('2026-10-01', '2026-10-09')).toBe('?from=2026-10-01&to=2026-10-09');
  });
});

describe('AffiliateSkuStats', () => {
  it('starts on the last 30 days and renders the per-SKU rows', async () => {
    await mount();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![0]).toMatch(/^\/affiliates\/aff-1\/stats\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
    expect(document.body.textContent).toContain('A-1');
    expect(document.body.textContent).toContain('Alpha / Green');
    expect(document.body.textContent).toContain('$14.00'); // sales total
    expect(document.body.textContent).toContain('$10.40'); // A-1 commission
  });

  it('all time sends no dates; a custom range sends exactly the typed days', async () => {
    await mount();
    await change(document.getElementById('aff-range') as HTMLSelectElement, 'all'); await flush();
    expect(get.mock.calls.at(-1)![0]).toBe('/affiliates/aff-1/stats');
    await change(document.getElementById('aff-from') as HTMLInputElement, '2026-09-01'); await flush();
    await change(document.getElementById('aff-to') as HTMLInputElement, '2026-09-30'); await flush();
    expect(get.mock.calls.at(-1)![0]).toBe('/affiliates/aff-1/stats?from=2026-09-01&to=2026-09-30');
    expect((document.getElementById('aff-range') as HTMLSelectElement).value).toBe('custom');
  });

  it('does not query an inverted range', async () => {
    await mount();
    await change(document.getElementById('aff-from') as HTMLInputElement, '2026-10-09'); await flush();
    await change(document.getElementById('aff-to') as HTMLInputElement, '2026-10-01'); await flush();
    const before = get.mock.calls.length;
    await flush();
    expect(get.mock.calls.length).toBe(before);
    expect(document.body.textContent).toContain('From must be on or before To');
  });
});
