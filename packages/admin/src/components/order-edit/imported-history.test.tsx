// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EditContext, ImportedOrderHistoryEntry } from './types';

const get = vi.fn();
const post = vi.fn(async (_path: string, _body: unknown) => ({ settlement: { status: 'settled' } }));
vi.mock('../../api', () => ({ api: { get: () => get(), post: (path: string, body: unknown) => post(path, body) }, ApiError: class extends Error {} }));
vi.mock('../Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: async () => true, dialog: null }) }));
import { EditHistory } from './EditHistory';

const imported: ImportedOrderHistoryEntry = {
  kind: 'imported', id: 'imported-1', createdAt: null, updatedAt: null,
  sourceCreatedAtText: '2024-04-03T11:22:33.123456', sourceUpdatedAtText: '2024-04-04T11:22:33.123456',
  priceChange: -1200, note: '<img src=x onerror=alert(1)> Historical note',
  lineChanges: [{ lineId: null, label: '<script>Widget</script>', quantityDelta: -2 },
    { lineId: 'line', label: 'Widget', quantityDelta: 0 }, { lineId: 'line', label: 'Widget', quantityDelta: 3 }],
  addressChanges: { shipping: { fields: [{ label: 'City', value: '<b>Recorded city</b>' }] }, billing: null },
  links: { refundId: 'mapped-refund', paymentId: 'mapped-payment' }, actionable: false,
};
const native: EditContext['history'][number] = {
  id: 'native-1', actor: 'Operator', reason: 'Native note', balance: -500, createdAt: '2026-10-01T00:00:00Z',
  grandTotalBefore: 2000, grandTotalAfter: 1500, settlement: { type: 'refund_now', status: 'failed', message: 'declined' },
};
let root: Root | undefined;
let queryClient: QueryClient | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  queryClient?.clear(); root = undefined; queryClient = undefined;
  document.body.innerHTML = ''; vi.clearAllMocks();
});
async function mount(history: EditContext['history'] = [], importedHistory = [imported]) {
  get.mockResolvedValue({ history, importedHistory });
  const el = document.createElement('div'); document.body.appendChild(el);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={queryClient!}><EditHistory code="X" currency="USD" payments={[]} onChanged={() => {}} /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  return el;
}

describe('imported edit history display', () => {
  it('renders imported-only history with signed/zero deltas & source timestamps unchanged', async () => {
    const el = await mount();
    expect(el.textContent).toContain('Imported history · Read-only');
    expect(el.textContent).toContain(imported.sourceCreatedAtText);
    expect(el.textContent).toContain(`Updated: ${imported.sourceUpdatedAtText}`);
    expect(el.textContent).toContain('Source-recorded price change: -$12.00');
    for (const delta of ['-2', '0', '+3']) expect(el.textContent).toContain(`Quantity delta: ${delta}`);
    expect(el.textContent).toContain('Linked refund: mapped-refund');
    expect(el.textContent).toContain('Linked payment: mapped-payment');
    expect(el.querySelectorAll('button,select').length).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('renders note, labels & whitelisted address values as text', async () => {
    const el = await mount();
    expect(el.textContent).toContain(imported.note);
    expect(el.textContent).toContain('<script>Widget</script>');
    expect(el.textContent).toContain('City: <b>Recorded city</b>');
    expect(el.querySelector('img,script,b')).toBeNull();
  });

  it('keeps recovery controls exclusive to native edits even with extraneous imported settlement data', async () => {
    const malicious = { ...imported, settlement: { type: 'refund_now', status: 'failed' } };
    const el = await mount([native], [malicious]);
    expect(el.querySelector('[data-testid="imported-edit-imported-1"]')?.querySelectorAll('button,select').length).toBe(0);
    const nativeRow = el.querySelector('[data-testid="edit-native-1"]')!;
    expect(nativeRow.querySelectorAll('button').length).toBe(2);
    await act(async () => { (nativeRow.querySelector('button') as HTMLButtonElement).click(); });
    expect(post).toHaveBeenCalledWith('/orders/X/edit/native-1/refund', { action: 'retry' });
  });
});
