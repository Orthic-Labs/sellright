// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  config: { configured: false, url: null as string | null, listId: null as number | null },
  patch: vi.fn(async (_path: string, _body: unknown) => ({ ok: true, lists: 1 })),
}));
vi.mock('../api', () => ({ api: {
  get: async (path: string) => path === '/marketing/config' ? mocks.config : { lists: [] },
  patch: mocks.patch,
} }));
vi.mock('../auth', () => ({ useAuth: () => ({ store: { slug: 'store-1' } }) }));

import Marketing from './Marketing';

let root: Root;
let client: QueryClient;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
async function mount() {
  const element = document.createElement('div'); document.body.appendChild(element);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(element);
  await act(async () => { root.render(<QueryClientProvider client={client}><Marketing /></QueryClientProvider>); });
  await flush();
}
async function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  mocks.config = { configured: false, url: null, listId: null };
  mocks.patch.mockClear();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  document.body.innerHTML = '';
});

describe('Marketing signup list configuration', () => {
  it('requires a positive list ID & sends it as a number when connecting', async () => {
    await mount();
    await fill('lm-url', 'https://listmonk.example.com');
    await fill('lm-user', 'api-user');
    await fill('lm-token', 'token');
    const button = document.querySelector<HTMLButtonElement>('button[form="lm-connect"]')!;
    expect(button.disabled).toBe(true);
    await fill('lm-list', '1.5');
    expect(button.disabled).toBe(true);
    await fill('lm-list', '7');
    expect(button.disabled).toBe(false);
    await act(async () => {
      document.getElementById('lm-connect')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mocks.patch).toHaveBeenCalledWith('/marketing/config', {
      url: 'https://listmonk.example.com', apiUser: 'api-user', apiToken: 'token', listId: 7,
    });
  });

  it('shows queued enrollments for legacy connections missing a destination', async () => {
    mocks.config = { configured: true, url: 'https://listmonk.example.com', listId: null };
    await mount();
    expect(document.body.textContent).toContain('Signup list required');
    expect(document.body.textContent).toContain('stay queued');
  });

  it('keeps configured list ID when opening the connection form', async () => {
    mocks.config = { configured: true, url: 'https://listmonk.example.com', listId: 9 };
    await mount();
    expect(document.body.textContent).toContain('sync to list 9');
    const button = [...document.querySelectorAll('button')].find(element => element.textContent === 'Reconfigure')!;
    await act(async () => button.click());
    expect((document.getElementById('lm-list') as HTMLInputElement).value).toBe('9');
    expect((document.getElementById('lm-url') as HTMLInputElement).value).toBe('https://listmonk.example.com');
    expect((document.getElementById('lm-token') as HTMLInputElement).value).toBe('');
  });
});
