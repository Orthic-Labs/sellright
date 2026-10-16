// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProductDetail } from '../api';

const mocks = vi.hoisted(() => ({
  id: 'p1', store: { slug: 'first', currency: 'USD' }, get: vi.fn(), patch: vi.fn(), post: vi.fn(), uploadAsset: vi.fn(), success: vi.fn(), error: vi.fn(),
}));
vi.mock('../api', () => ({
  api: { get: mocks.get, patch: mocks.patch, post: mocks.post },
  auth: { get store() { return localStorage.getItem('sr_admin_store'); } },
  assetUrl: (path: string | null) => path, uploadAsset: mocks.uploadAsset,
}));
vi.mock('../auth', () => ({ useAuth: () => ({ store: mocks.store }) }));
vi.mock('../components/Toast', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error }) }));
vi.mock('react-router-dom', async (original) => ({
  ...await original<typeof import('react-router-dom')>(), useParams: () => ({ id: mocks.id }),
}));

import ProductDetailPage from './ProductDetail';

function product(id = 'p1', name = 'Original'): ProductDetail {
  return {
    id, name, slug: id, description: 'Description', status: 'active', assetPath: '/image.webp', featuredAssetId: 'image', images: [],
    variants: [{ id: 'v1', sku: 'SKU-1', name: 'First', price: 1000, salePrice: null, enabled: true, onHand: 4, allocated: 0, available: 4 }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let root: Root;
let client: QueryClient;
let products: Record<string, ProductDetail>;
const key = () => ['product', mocks.store.slug, mocks.id];
const server = () => products[`${mocks.store.slug}:${mocks.id}`]!;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!;
const title = () => document.querySelector<HTMLInputElement>('section input')!;
const price = (id = 'SKU-1') => [...document.querySelectorAll<HTMLTableRowElement>('tbody tr')].find((row) => row.textContent?.includes(id))!.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pickImage(index: number) {
  const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[index]!;
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'image.png', { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function render() {
  root.render(<QueryClientProvider client={client}><MemoryRouter><ProductDetailPage /></MemoryRouter></QueryClientProvider>);
}
async function mount() {
  const element = document.createElement('div'); document.body.appendChild(element);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(element);
  await act(async () => { render(); });
  await flush();
}
function persist(path: string, body: Record<string, unknown>) {
  if (path.startsWith('/products/')) {
    Object.assign(server(), body);
    if (body.featuredAssetId === null) server().assetPath = null;
  } else {
    const variant = server().variants.find((row) => row.id === path.split('/')[2])!;
    Object.assign(variant, body);
  }
  return {};
}
beforeEach(() => {
  mocks.id = 'p1'; mocks.store = { slug: 'first', currency: 'USD' };
  localStorage.setItem('sr_admin_store', 'first');
  products = { 'first:p1': product(), 'first:p2': product('p2', 'Second product'), 'second:p1': product('p1', 'Second store') };
  mocks.get.mockReset().mockImplementation(async (path: string) => path.endsWith('/options') ? { groups: [] } : structuredClone(server()));
  mocks.patch.mockReset().mockImplementation(async (path: string, body: Record<string, unknown>) => persist(path, body));
  mocks.post.mockReset().mockResolvedValue({});
  mocks.uploadAsset.mockReset().mockResolvedValue({ id: 'uploaded' });
  mocks.success.mockReset(); mocks.error.mockReset();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear(); localStorage.clear(); document.body.innerHTML = '';
});

describe('Product draft hydration', () => {
  it('retains title, description, status & variant edits after an independent media PATCH/refetch', async () => {
    await mount();
    await fill(title(), 'Unsaved title');
    await fill(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Unsaved description');
    await fill(price(), '25.00');
    await act(async () => {
      const status = document.querySelector<HTMLSelectElement>('select')!;
      status.value = 'draft'; status.dispatchEvent(new Event('change', { bubbles: true }));
      button('Remove').click();
    });
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith('/products/p1', { featuredAssetId: null });
    expect(client.getQueryData<ProductDetail>(key())!.featuredAssetId).toBeNull();
    expect(title().value).toBe('Unsaved title');
    expect(document.querySelector('textarea')!.value).toBe('Unsaved description');
    expect(document.querySelector('select')!.value).toBe('draft');
    expect(price().value).toBe('25.00');
    expect(button('Save changes').disabled).toBe(false);
  });

  it('hydrates pristine fields after background updates', async () => {
    await mount();
    server().name = 'Remote title'; server().variants[0]!.price = 1600;
    await act(async () => { await client.invalidateQueries({ queryKey: key() }); }); await flush();
    expect(title().value).toBe('Remote title'); expect(price().value).toBe('16.00');
    expect(button('Save changes').disabled).toBe(true);
  });

  it('matches variant edits by ID across additions, removals & reordered responses', async () => {
    await mount(); await fill(price(), '25.00');
    const original = server().variants[0]!;
    server().variants = [{ ...original, id: 'v2', sku: 'SKU-2', name: 'Second', price: 2000 }, original];
    await act(async () => { await client.invalidateQueries({ queryKey: key() }); }); await flush();
    expect(price('SKU-1').value).toBe('25.00'); expect(price('SKU-2').value).toBe('20.00');
    server().variants = server().variants.filter((row) => row.id !== 'v1');
    await act(async () => { await client.invalidateQueries({ queryKey: key() }); }); await flush();
    expect(document.body.textContent).not.toContain('SKU-1');
    expect(price('SKU-2').value).toBe('20.00');
    expect(button('Save changes').disabled).toBe(true);
  });

  it('accepts successful Save as baseline & preserves edits made while Save is pending', async () => {
    await mount(); await fill(title(), 'Submitted'); await fill(price(), '22.00');
    const pending = deferred<void>();
    mocks.patch.mockImplementationOnce(async (path: string, body: Record<string, unknown>) => { await pending.promise; return persist(path, body); });
    await act(async () => { button('Save changes').click(); });
    await fill(title(), 'Typed during save'); await fill(price(), '23.00');
    await act(async () => { pending.resolve(); }); await flush();
    expect(server().name).toBe('Submitted'); expect(server().variants[0]!.price).toBe(2200);
    expect(title().value).toBe('Typed during save'); expect(price().value).toBe('23.00');
    expect(button('Save changes').disabled).toBe(false);
    await fill(title(), 'Submitted'); await fill(price(), '22.00');
    expect(button('Save changes').disabled).toBe(true);
    await fill(title(), 'Saved next');
    await act(async () => { button('Save changes').click(); }); await flush();
    expect(button('Save changes').disabled).toBe(true);
    expect(title().value).toBe('Saved next');
  });

  it('ignores a pre-save query response that arrives after Save completes', async () => {
    await mount(); await fill(title(), 'Saved title');
    const old = structuredClone(server()); const pending = deferred<ProductDetail>();
    mocks.get.mockImplementationOnce(() => pending.promise);
    await act(async () => { void client.invalidateQueries({ queryKey: key() }); }); await flush();
    await act(async () => { button('Save changes').click(); }); await flush();
    expect(button('Save changes').disabled).toBe(true);
    await act(async () => { pending.resolve(old); }); await flush();
    expect(title().value).toBe('Saved title');
    expect(client.getQueryData<ProductDetail>(key())!.name).toBe('Saved title');
    expect(button('Save changes').disabled).toBe(true);
  });

  it('cancels a stale read started while Save PATCHes are pending', async () => {
    await mount(); await fill(title(), 'Saved title');
    const old = structuredClone(server());
    const write = deferred<void>(); const read = deferred<ProductDetail>();
    mocks.patch.mockImplementationOnce(async (path: string, body: Record<string, unknown>) => { await write.promise; return persist(path, body); });
    await act(async () => { button('Save changes').click(); });
    mocks.get.mockImplementationOnce(() => read.promise);
    await act(async () => { void client.invalidateQueries({ queryKey: key() }); }); await flush();
    await act(async () => { write.resolve(); }); await flush();
    await act(async () => { read.resolve(old); }); await flush();
    expect(title().value).toBe('Saved title');
    expect(client.getQueryData<ProductDetail>(key())!.name).toBe('Saved title');
    expect(button('Save changes').disabled).toBe(true);
  });

  it('stops old Save requests after store identity changes & keeps the new store draft', async () => {
    await mount(); await fill(title(), 'Submitted'); await fill(price(), '22.00');
    const oldStoreProduct = server(); const write = deferred<void>();
    mocks.patch.mockImplementationOnce(async (_path: string, body: Record<string, unknown>) => { await write.promise; Object.assign(oldStoreProduct, body); return {}; });
    await act(async () => { button('Save changes').click(); });
    localStorage.setItem('sr_admin_store', 'second'); mocks.store = { slug: 'second', currency: 'USD' };
    await act(async () => { render(); }); await flush();
    await fill(title(), 'New store edit');
    await act(async () => { write.resolve(); }); await flush();
    expect(title().value).toBe('New store edit');
    expect(server().name).toBe('Second store'); expect(server().variants[0]!.price).toBe(1000);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(['product', 'first', 'p1'])!.isInvalidated).toBe(true);
  });

  it('stops Save continuation when transport store switches before React cleanup', async () => {
    await mount(); await fill(title(), 'Submitted'); await fill(price(), '22.00');
    const oldStoreProduct = server(); const write = deferred<void>();
    mocks.patch.mockImplementationOnce(async (_path: string, body: Record<string, unknown>) => { await write.promise; Object.assign(oldStoreProduct, body); return {}; });
    await act(async () => { button('Save changes').click(); });
    const reads = mocks.get.mock.calls.length;
    // Leave the editor mounted: only the transport's active-store value changes.
    localStorage.setItem('sr_admin_store', 'second');
    await act(async () => { write.resolve(); }); await flush();
    expect(mocks.patch).toHaveBeenCalledTimes(1); expect(mocks.get).toHaveBeenCalledTimes(reads);
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
    mocks.store = { slug: 'second', currency: 'USD' };
    await act(async () => { render(); }); await flush();
    expect(title().value).toBe('Second store'); expect(server().variants[0]!.price).toBe(1000);
  });

  it.each([{ index: 0, kind: 'featured image' }, { index: 1, kind: 'gallery image' }])('stops $kind upload attachment when transport store switches before cleanup', async ({ index }) => {
    await mount(); const upload = deferred<{ id: string }>();
    mocks.uploadAsset.mockReturnValueOnce(upload.promise);
    await pickImage(index);
    expect(mocks.uploadAsset).toHaveBeenCalledTimes(1);
    const reads = mocks.get.mock.calls.length;
    localStorage.setItem('sr_admin_store', 'second');
    await act(async () => { upload.resolve({ id: 'old-store-upload' }); }); await flush();
    expect(mocks.patch).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledTimes(reads);
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
    mocks.store = { slug: 'second', currency: 'USD' };
    await act(async () => { render(); }); await flush();
    expect(title().value).toBe('Second store');
    expect(server().featuredAssetId).toBe('image'); expect(server().images).toEqual([]);
  });

  it.each([{ index: 0, kind: 'featured image' }, { index: 1, kind: 'gallery image' }])('ignores $kind attachment completion after store navigation', async ({ index }) => {
    await mount(); const attachment = deferred<unknown>();
    if (index === 0) mocks.patch.mockReturnValueOnce(attachment.promise);
    else mocks.post.mockReturnValueOnce(attachment.promise);
    await pickImage(index); await flush();
    if (index === 0) expect(mocks.patch).toHaveBeenCalledWith('/products/p1', { featuredAssetId: 'uploaded' });
    else expect(mocks.post).toHaveBeenCalledWith('/products/p1/assets', { assetId: 'uploaded' });
    localStorage.setItem('sr_admin_store', 'second'); mocks.store = { slug: 'second', currency: 'USD' };
    await act(async () => { render(); }); await flush();
    await fill(title(), 'New store edit');
    const reads = mocks.get.mock.calls.length;
    await act(async () => { attachment.resolve({}); }); await flush();
    expect(title().value).toBe('New store edit'); expect(mocks.get).toHaveBeenCalledTimes(reads);
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
    expect(client.getQueryState(['product', 'first', 'p1'])!.isInvalidated).toBe(false);
  });

  it('resets for product & store identity changes, ignoring previous identity responses', async () => {
    await mount(); await fill(title(), 'Unsaved first');
    const old = structuredClone(server()); const pending = deferred<ProductDetail>();
    mocks.get.mockImplementationOnce(() => pending.promise);
    await act(async () => { void client.invalidateQueries({ queryKey: key() }); }); await flush();
    mocks.id = 'p2'; await act(async () => { render(); }); await flush();
    expect(title().value).toBe('Second product');
    await act(async () => { pending.resolve(old); }); await flush();
    expect(title().value).toBe('Second product');
    await fill(title(), 'Unsaved second');
    mocks.id = 'p1'; localStorage.setItem('sr_admin_store', 'second'); mocks.store = { slug: 'second', currency: 'USD' };
    await act(async () => { render(); }); await flush();
    expect(title().value).toBe('Second store'); expect(button('Save changes').disabled).toBe(true);
  });
});
