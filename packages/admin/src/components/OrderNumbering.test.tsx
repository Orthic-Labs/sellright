// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn(); const patch = vi.fn();
vi.mock('../api', () => ({ api: { get: (p: string) => get(p), patch: (p: string, b?: unknown) => patch(p, b) } }));
vi.mock('../auth', () => ({ useAuth: () => ({ store: { slug: 'rh', currency: 'USD' } }) }));
const { OrderNumbering, previewOrderCode } = await import('./OrderNumbering');

function setInput(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function until<T>(probe: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 200; i++) { const v = probe(); if (v) return v; await flush(); }
  throw new Error('condition never settled');
}
const button = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const defaults = { prefix: '', suffix: '', minDigits: 0, nextNumber: 1001, preview: '1001', highestExisting: null };

async function mount(canManage = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => { root.render(<QueryClientProvider client={qc}><OrderNumbering canManage={canManage} /></QueryClientProvider>); });
  await flush();
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('previewOrderCode', () => {
  it('formats prefix, padding and suffix like the API', () => {
    expect(previewOrderCode({ prefix: 'RH', suffix: '', minDigits: '6', nextNumber: '1' })).toBe('RH000001');
    expect(previewOrderCode({ prefix: 'DD', suffix: '', minDigits: '0', nextNumber: '30306' })).toBe('DD30306');
    expect(previewOrderCode({ prefix: '#', suffix: '-X', minDigits: '', nextNumber: '1001' })).toBe('#1001-X');
    expect(previewOrderCode({ prefix: '', suffix: '', minDigits: '0', nextNumber: '0' })).toBeNull();
    expect(previewOrderCode({ prefix: '', suffix: '', minDigits: '13', nextNumber: '5' })).toBeNull();
  });
});

describe('OrderNumbering', () => {
  it('shows the next code, edits the format with a live preview and saves it', async () => {
    get.mockResolvedValue(defaults);
    patch.mockResolvedValue({ prefix: 'RH', suffix: '', minDigits: 6, nextNumber: 1, preview: 'RH000001', highestExisting: null });
    const { container, done } = await mount();
    await until(() => container.textContent?.includes('1001'));
    expect(get).toHaveBeenCalledWith('/settings/order-numbering');
    act(() => button(container, 'Edit order numbers').click());
    act(() => {
      setInput(container.querySelector('#on-prefix')!, 'RH');
      setInput(container.querySelector('#on-digits')!, '6');
      setInput(container.querySelector('#on-next')!, '1');
    });
    expect(container.querySelector('[data-testid="order-number-preview"]')!.textContent).toBe('RH000001');
    await act(async () => { button(container, 'Save').click(); });
    await until(() => !container.querySelector('#on-prefix'));
    expect(patch).toHaveBeenCalledWith('/settings/order-numbering', { prefix: 'RH', suffix: '', minDigits: 6, nextNumber: 1 });
    expect(container.textContent).toContain('RH000001');
    done();
  });

  it('shows the API collision error and keeps the form open', async () => {
    get.mockResolvedValue({ ...defaults, prefix: 'DD', preview: 'DD30300', nextNumber: 30300, highestExisting: 'DD30287' });
    patch.mockRejectedValue(new Error('Order DD30287 already exists in this format; the next number must be at least 30288'));
    const { container, done } = await mount();
    await until(() => container.textContent?.includes('DD30300'));
    expect(container.textContent).toContain('DD30287');
    act(() => button(container, 'Edit order numbers').click());
    act(() => setInput(container.querySelector('#on-next')!, '30000'));
    await act(async () => { button(container, 'Save').click(); });
    await until(() => container.textContent?.includes('already exists'));
    expect(container.querySelector('#on-next')).not.toBeNull();
    done();
  });

  it('is read-only for roles that cannot manage settings', async () => {
    get.mockResolvedValue(defaults);
    const { container, done } = await mount(false);
    await until(() => container.textContent?.includes('1001'));
    expect(button(container, 'Edit order numbers')).toBeUndefined();
    expect(container.textContent).toContain('Only owners and managers');
    done();
  });
});
