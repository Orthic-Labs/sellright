// @vitest-environment jsdom
// The export dialog must start from the list's filters and send every choice
// to the export endpoint (date range, statuses, row mode, picked columns).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const downloadFile = vi.fn(async (_path: string, _name: string) => undefined);
const CATALOG = {
  columns: [
    { key: 'code', label: 'Order', group: 'Order', lineOnly: false },
    { key: 'email', label: 'Email', group: 'Customer', lineOnly: false },
    { key: 'paymentStatus', label: 'Payment status', group: 'Status', lineOnly: false },
    { key: 'sku', label: 'SKU', group: 'Line item', lineOnly: true },
    { key: 'quantity', label: 'Quantity', group: 'Line item', lineOnly: true },
  ],
  defaults: ['code', 'email'], lineDefaults: ['sku', 'quantity'], cap: 50000,
};
vi.mock('../api', () => ({ api: { get: vi.fn(async () => CATALOG) }, downloadFile: (p: string, n: string) => downloadFile(p, n) }));
vi.mock('../auth', () => ({ useAuth: () => ({ store: { slug: 'dd', currency: 'USD' } }) }));
vi.mock('./Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import OrderExportDialog from './OrderExportDialog';
import { EMPTY_FILTERS } from '../lib/order-status';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
afterEach(() => { document.body.innerHTML = ''; downloadFile.mockClear(); });

async function mount(filters = EMPTY_FILTERS) {
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={qc}><OrderExportDialog open onClose={() => undefined} filters={filters} /></QueryClientProvider>); });
  await flush();
}
const byText = (sel: string, text: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text))!;
const change = (el: HTMLSelectElement | HTMLInputElement, value: string) => act(async () => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

describe('OrderExportDialog', () => {
  it('seeds from the current list filters and downloads with them', async () => {
    await mount({ ...EMPTY_FILTERS, paymentStatus: 'paid', from: '2026-09-01', to: '2026-09-30' });
    expect((document.getElementById('ex-pay') as HTMLSelectElement).value).toBe('paid');
    expect((document.getElementById('ex-from') as HTMLInputElement).value).toBe('2026-09-01');
    await act(async () => { byText('button', 'Download CSV').click(); });
    await flush();
    const url = downloadFile.mock.calls[0]![0] as string;
    expect(url.startsWith('/export/orders?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('paymentStatus')).toBe('paid');
    expect(q.get('from')).toBe('2026-09-01');
    expect(q.get('to')).toBe('2026-09-30');
    expect(q.get('rows')).toBe('order');
    expect(q.get('columns')).toBe('code,email');
  });

  it('switching to line items adds line columns; XLSX uses the xlsx endpoint', async () => {
    await mount();
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="ex-rows"]')];
    await act(async () => { radios[1]!.click(); });
    await act(async () => { document.querySelectorAll<HTMLInputElement>('input[name="ex-fmt"]')[1]!.click(); });
    await change(document.getElementById('ex-pre') as HTMLSelectElement, '1');
    await act(async () => { byText('button', 'Download XLSX').click(); });
    await flush();
    const url = downloadFile.mock.calls[0]![0] as string;
    expect(url.startsWith('/export/orders.xlsx?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('rows')).toBe('line');
    expect(q.get('columns')).toBe('code,email,sku,quantity');
    expect(q.get('preOrder')).toBe('1');
  });

  it('blocks an inverted date range', async () => {
    await mount();
    await change(document.getElementById('ex-from') as HTMLInputElement, '2026-10-05');
    await change(document.getElementById('ex-to') as HTMLInputElement, '2026-10-01');
    expect(document.body.textContent).toContain('start date is after the end date');
    expect((byText('button', 'Download CSV') as HTMLButtonElement).disabled).toBe(true);
  });
});
