// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Keep the real API helper: assertions observe composed fetch URLs & auth.
vi.mock('../qa-mocks.js', () => ({ maybeMock: () => null }));
vi.mock('../auth', () => ({ useAuth: () => ({ store: { slug: 'store-1' } }) }));
import Webhooks from './Webhooks';

let root: Root;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text)!;
async function fill(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear(); vi.unstubAllGlobals(); localStorage.clear();
  document.cookie = 'sr_csrf=; Max-Age=0; path=/'; document.body.innerHTML = '';
});

describe('Webhook network paths', () => {
  it('uses one admin prefix for list, create, toggle & delete with existing auth semantics', async () => {
    const endpoint = { id: 'hook-1', url: 'https://merchant.example/hook', topics: ['order.paid'], enabled: true };
    const network = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(init?.method === 'GET' ? { items: [endpoint] } : init?.method === 'POST' ? { id: 'hook-2', secret: 'secret-once' } : {}),
    }));
    vi.stubGlobal('fetch', network);
    localStorage.setItem('sr_admin_store', 'store-1'); document.cookie = 'sr_csrf=csrf-test; path=/';
    const element = document.createElement('div'); document.body.appendChild(element);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    root = createRoot(element);
    await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter><Webhooks /></MemoryRouter></QueryClientProvider>); }); await flush();
    await act(async () => { button('Add endpoint').click(); });
    await fill('input[type="url"]', ' https://merchant.example/new ');
    await fill('input[placeholder="order.created, order.paid, *"]', 'order.paid, order.created');
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush();
    await act(async () => { document.querySelector<HTMLButtonElement>('button[title="Click to disable"]')!.click(); }); await flush();
    await act(async () => { document.querySelector<HTMLButtonElement>('button[title="Delete endpoint"]')!.click(); });
    await act(async () => { button('Yes').click(); }); await flush();

    const calls = network.mock.calls.map(([url, init]) => ({ url, method: init?.method, init }));
    expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.method === 'GET').every((call) => call.url === '/v1/admin/webhooks')).toBe(true);
    for (const [method, url, body] of [
      ['POST', '/v1/admin/webhooks', { url: 'https://merchant.example/new', topics: ['order.paid', 'order.created'] }],
      ['PATCH', '/v1/admin/webhooks/hook-1', { enabled: false }],
      ['DELETE', '/v1/admin/webhooks/hook-1', undefined],
    ] as const) {
      const call = calls.find((entry) => entry.method === method)!;
      expect(call?.url).toBe(url);
      expect(call.init?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
      expect(call.init?.headers).toMatchObject({ 'x-store-slug': 'store-1', 'x-csrf-token': 'csrf-test' });
    }
    for (const call of calls) expect(call.init?.credentials).toBe('include');
  });
});
