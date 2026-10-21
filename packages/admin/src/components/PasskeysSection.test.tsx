// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

class FakeApiError extends Error { code?: string; constructor(public status: number, m: string) { super(m); } }
const caps = vi.fn(); const list = vi.fn(); const reg = vi.fn(); const del = vi.fn(); const post = vi.fn();
vi.mock('../api', () => ({ api: { post: (p: string, b?: unknown) => post(p, b) }, ApiError: FakeApiError }));
vi.mock('../lib/passkeys', async () => {
  const actual = await vi.importActual<typeof import('../lib/passkeys')>('../lib/passkeys');
  return {
    ...actual,
    browserSupportsWebAuthn: () => true,
    capabilities: () => caps(), listPasskeys: () => list(), registerPasskey: (l: string) => reg(l), deletePasskey: (id: string) => del(id),
    stepUpWithPasskey: vi.fn(),
  };
});
const { PasskeysSection } = await import('./PasskeysSection');

function setInput(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Two chained queries (capabilities, then the list) settle on their own schedule; poll instead of counting ticks. */
async function until<T>(probe: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 200; i++) { const v = probe(); if (v) return v; await flush(); }
  throw new Error('condition never settled');
}
const row = { id: 'p1', label: 'Work laptop', deviceType: 'singleDevice', backedUp: false, createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null };

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => { root.render(<QueryClientProvider client={qc}><PasskeysSection /></QueryClientProvider>); });
  await flush(); await flush();
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}
const button = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

beforeEach(() => { vi.clearAllMocks(); });

describe('PasskeysSection', () => {
  it('renders nothing when passkeys are disabled', async () => {
    caps.mockResolvedValue({ passkeys: false });
    const { container, done } = await mount();
    expect(container.textContent).toBe('');
    expect(list).not.toHaveBeenCalled();
    done();
  });

  it('lists passkeys, adds one, and retries after step-up', async () => {
    caps.mockResolvedValue({ passkeys: true });
    list.mockResolvedValue([row]);
    const stepErr = new FakeApiError(403, 'step_up_required');
    reg.mockRejectedValueOnce(stepErr).mockResolvedValueOnce({ ...row, id: 'p2' });
    post.mockResolvedValue({ ok: true });
    const { container, done } = await mount();
    await until(() => container.textContent?.includes('Work laptop'));
    expect(container.textContent).toContain('This device');
    const label = await until(() => container.querySelector('#pk-label') as HTMLInputElement | null);
    act(() => { setInput(label, 'Phone'); });
    act(() => { button(container, 'Add a passkey').click(); });
    await until(() => document.body.querySelector('[role="dialog"]'));
    expect(reg).toHaveBeenCalledWith('Phone');
    act(() => { setInput(document.body.querySelector('input[type="password"]') as HTMLInputElement, 'pw'); });
    act(() => { (document.body.querySelector('[role="dialog"] form') as HTMLFormElement).requestSubmit(); });
    await until(() => reg.mock.calls.length === 2);
    expect(post).toHaveBeenCalledWith('/step-up', { password: 'pw', totp: undefined });
    done();
  });

  it('shows TOTP_REQUIRED_FIRST message', async () => {
    caps.mockResolvedValue({ passkeys: true });
    list.mockResolvedValue([]);
    const e = new FakeApiError(409, 'raw'); e.code = 'TOTP_REQUIRED_FIRST';
    reg.mockRejectedValue(e);
    const { container, done } = await mount();
    const label = await until(() => container.querySelector('#pk-label') as HTMLInputElement | null);
    act(() => { setInput(label, 'X'); });
    act(() => { button(container, 'Add a passkey').click(); });
    await until(() => container.textContent?.includes('Set up your authenticator app first'));
    done();
  });

  it('removes a passkey after confirmation', async () => {
    caps.mockResolvedValue({ passkeys: true });
    list.mockResolvedValue([row]);
    del.mockResolvedValue(undefined);
    const { container, done } = await mount();
    const remove = await until(() => container.querySelector('[aria-label="Remove Work laptop"]') as HTMLButtonElement | null);
    act(() => { remove.click(); });
    expect(del).not.toHaveBeenCalled();
    act(() => { button(document.body as unknown as HTMLElement, 'Remove').click(); });
    await flush();
    expect(del).toHaveBeenCalledWith('p1');
    done();
  });
});
