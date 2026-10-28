// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProductDetail } from '../api';

const mocks = vi.hoisted(() => ({
  id: 'p1', store: { slug: 'first', currency: 'USD' }, get: vi.fn(), patch: vi.fn(), post: vi.fn(), del: vi.fn(), push: vi.fn(), uploadAsset: vi.fn(), success: vi.fn(), error: vi.fn(),
}));
vi.mock('../api', () => ({
  ApiError: class ApiError extends Error { constructor(public status: number, message: string) { super(message); } },
  api: { get: mocks.get, patch: mocks.patch, post: mocks.post, del: mocks.del },
  auth: { get store() { return localStorage.getItem('sr_admin_store'); } },
  assetUrl: (path: string | null) => path, uploadAsset: mocks.uploadAsset,
}));
vi.mock('../auth', () => ({ useAuth: () => ({ store: mocks.store }) }));
vi.mock('../components/Toast', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error, push: mocks.push }) }));
vi.mock('react-router-dom', async (original) => ({
  ...await original<typeof import('react-router-dom')>(), useParams: () => ({ id: mocks.id }),
}));

import ProductDetailPage from './ProductDetail';
import { ApiError } from '../api';

function product(id = 'p1', name = 'Original'): ProductDetail {
  return ({
    id, name, slug: id, description: 'Description', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z', assetPath: '/image.webp', featuredAssetId: 'image', images: [{ assetId: 'image', path: '/image.webp', position: 0 }, { assetId: 'second-image', path: '/second.webp', position: 1 }],
    variants: [{ id: 'v1', sku: 'SKU-1', name: 'First', price: 1000, salePrice: null, enabled: true, updatedAt: '2026-01-01T00:00:00.000Z', onHand: 4, allocated: 0, available: 4 }],
  }) as ProductDetail;
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
const isLocked = () => document.querySelector('fieldset')!.disabled;
const server = () => products[`${mocks.store.slug}:${mocks.id}`]!;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!;
const title = () => document.querySelector<HTMLInputElement>('#pt')!;
const description = () => document.querySelector<HTMLTextAreaElement>('#pdsc')!;
const row = (id: string) => [...document.querySelectorAll<HTMLTableRowElement>('tbody tr[data-vid]')].find((node) => node.textContent?.includes(id))!;
const onHand = (id = 'SKU-1') => row(id).querySelector<HTMLInputElement>('input[aria-label^="On hand,"]')!;
const clickText = (text: string) => act(async () => { button(text).click(); });
const menuItem = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === text)!;
const price = (id = 'SKU-1') => row(id).querySelector<HTMLInputElement>('input[aria-label^="Price,"]')!;
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
let revision = 0;
function persist(path: string, body: Record<string, unknown>) {
  const { expectedUpdatedAt: _expected, expectedOnHand: _expectedOnHand, ...fields } = body;
  if (path.startsWith('/products/')) {
    Object.assign(server(), fields);
    if (fields.featuredAssetId === null) server().assetPath = null;
    const updatedAt = `2026-02-01T00:00:0${++revision}.000Z`;
    Object.assign(server(), { updatedAt });
    return { id: server().id, updatedAt };
  }
  const variant = server().variants.find((row) => row.id === path.split('/')[2])!;
  if (path.endsWith('/stock')) { variant.onHand = fields.onHand as number; return {}; }
  const updatedAt = `2026-03-01T00:00:0${++revision}.000Z`;
  Object.assign(variant, fields, { updatedAt });
  return { id: variant.id, updatedAt };
}
beforeEach(() => {
  mocks.id = 'p1'; mocks.store = { slug: 'first', currency: 'USD' };
  localStorage.setItem('sr_admin_store', 'first');
  products = { 'first:p1': product(), 'first:p2': product('p2', 'Second product'), 'second:p1': product('p1', 'Second store') };
  revision = 0;
  mocks.get.mockReset().mockImplementation(async (path: string) => {
    if (path.endsWith('/options')) return { groups: [] };
    if (path === '/collections') return { items: [] };
    return structuredClone(server());
  });
  mocks.patch.mockReset().mockImplementation(async (path: string, body: Record<string, unknown>) => persist(path, body));
  mocks.post.mockReset().mockResolvedValue({}); mocks.del.mockReset().mockResolvedValue({}); mocks.push.mockReset();
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
    await fill(description(), 'Unsaved description');
    await fill(price(), '25.00');
    await clickText('Draft');
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Actions for image 2"]')!.click(); });
    await act(async () => { menuItem('Make main image').click(); });
    await flush();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith('/products/p1', { featuredAssetId: 'second-image', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    expect(client.getQueryData<ProductDetail>(key())!.featuredAssetId).toBe('second-image');
    expect(title().value).toBe('Unsaved title');
    expect(description().value).toBe('Unsaved description');
    expect(document.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toBe('Draft');
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

  it('sends nothing before Save changes', async () => {
    await mount(); await fill(title(), 'Staged'); await fill(price(), '22.00'); await fill(onHand(), '9');
    await flush();
    expect(mocks.patch).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.del).not.toHaveBeenCalled();
  });

  it('sends the product PATCH first with expectedUpdatedAt, then the variant & its stock', async () => {
    await mount(); await fill(title(), 'Submitted'); await fill(price(), '22.00'); await fill(onHand(), '9');
    await clickText('Save changes'); await flush();
    expect(mocks.patch.mock.calls).toEqual([
      ['/products/p1', { name: 'Submitted', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }],
      ['/variants/v1', { price: 2200, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }],
      ['/variants/v1/stock', { onHand: 9, expectedOnHand: 4 }],
    ]);
    // The next Save carries the stamp returned by the first.
    await fill(title(), 'Again'); await clickText('Save changes'); await flush();
    expect(mocks.patch.mock.calls[3]).toEqual(['/products/p1', { name: 'Again', expectedUpdatedAt: '2026-02-01T00:00:01.000Z' }]);
  });

  it('shows Use theirs / Keep mine on a 409 and sends no variant requests', async () => {
    await mount(); await fill(title(), 'Submitted'); await fill(price(), '22.00');
    mocks.patch.mockRejectedValueOnce(new ApiError(409, 'Product changed'));
    await clickText('Save changes'); await flush();
    expect(button('Use theirs')).toBeTruthy(); expect(button('Keep mine')).toBeTruthy();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch.mock.calls.some(([path]) => String(path).startsWith('/variants/'))).toBe(false);
    expect(title().value).toBe('Submitted'); expect(price().value).toBe('22.00');
  });

  it('sends the variant stamp & on-hand it loaded, then the ones it saved', async () => {
    await mount(); await fill(price(), '22.00'); await fill(onHand(), '9');
    await clickText('Save changes'); await flush();
    expect(mocks.patch.mock.calls).toEqual([
      ['/variants/v1', { price: 2200, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }],
      ['/variants/v1/stock', { onHand: 9, expectedOnHand: 4 }],
    ]);
    await fill(price(), '23.00'); await fill(onHand(), '7');
    await clickText('Save changes'); await flush();
    expect(mocks.patch.mock.calls.slice(2)).toEqual([
      ['/variants/v1', { price: 2300, expectedUpdatedAt: '2026-03-01T00:00:01.000Z' }],
      ['/variants/v1/stock', { onHand: 7, expectedOnHand: 9 }],
    ]);
  });

  it('shows Use theirs / Keep mine when a variant changed since it was loaded', async () => {
    await mount(); await fill(price(), '22.00');
    mocks.patch.mockRejectedValueOnce(new ApiError(409, 'Variant changed since you opened it'));
    await clickText('Save changes'); await flush();
    expect(button('Use theirs')).toBeTruthy(); expect(button('Keep mine')).toBeTruthy();
    expect(price().value).toBe('22.00');
  });

  it('shows Use theirs / Keep mine when stock moved since it was loaded, and Keep mine re-sends against the new on-hand', async () => {
    await mount(); await fill(onHand(), '9');
    server().variants[0]!.onHand = 3; // a fulfilment took one... or someone else edited it
    mocks.patch.mockRejectedValueOnce(new ApiError(409, 'Stock changed since you opened it'));
    await clickText('Save changes'); await flush();
    expect(button('Keep mine')).toBeTruthy();
    expect(mocks.patch.mock.calls).toEqual([['/variants/v1/stock', { onHand: 9, expectedOnHand: 4 }]]);
    await clickText('Keep mine'); await flush();
    expect(mocks.patch.mock.calls[1]).toEqual(['/variants/v1/stock', { onHand: 9, expectedOnHand: 3 }]);
  });

  it('blocks Save with a toast when variants have errors, sending nothing', async () => {
    await mount(); await fill(title(), 'Submitted'); await fill(price(), 'abc');
    await clickText('Save changes'); await flush();
    expect(mocks.error).toHaveBeenCalledWith('Fix 1 variant with errors before saving. Nothing was saved.');
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(title().value).toBe('Submitted');
  });

  it('accepts successful Save as baseline & locks the form while Save is pending', async () => {
    await mount(); await fill(title(), 'Submitted'); await fill(price(), '22.00');
    const pending = deferred<void>();
    mocks.patch.mockImplementationOnce(async (path: string, body: Record<string, unknown>) => { await pending.promise; return persist(path, body); });
    await clickText('Save changes');
    expect(isLocked()).toBe(true);
    expect(title().matches(':disabled')).toBe(true); expect(description().matches(':disabled')).toBe(true);
    expect(price().matches(':disabled')).toBe(true); expect(onHand().matches(':disabled')).toBe(true);
    expect(button('Saving…').disabled).toBe(true);
    await act(async () => { pending.resolve(); }); await flush();
    expect(isLocked()).toBe(false);
    expect(server().name).toBe('Submitted'); expect(server().variants[0]!.price).toBe(2200);
    expect(title().value).toBe('Submitted'); expect(price().value).toBe('22.00');
    expect(button('Save changes').disabled).toBe(true);
    await fill(title(), 'Saved next');
    expect(button('Save changes').disabled).toBe(false);
    await clickText('Save changes'); await flush();
    expect(button('Save changes').disabled).toBe(true);
    expect(title().value).toBe('Saved next');
  });

  it('ignores a pre-save query response that arrives after Save completes', async () => {
    await mount(); await fill(title(), 'Saved title');
    const old = structuredClone(server()); const pending = deferred<ProductDetail>();
    mocks.get.mockImplementationOnce(() => pending.promise);
    await act(async () => { void client.invalidateQueries({ queryKey: key() }); }); await flush();
    await clickText('Save changes'); await flush();
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
    await clickText('Save changes');
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
    await clickText('Save changes');
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
    await clickText('Save changes');
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

  // Featured: the product has no main image yet, so the upload is attached to the gallery and then made main.
  const noMain = () => { Object.assign(server(), { featuredAssetId: null, assetPath: null, images: [] }); };
  it.each([{ kind: 'featured image' }, { kind: 'gallery image' }])('stops $kind upload attachment when transport store switches before cleanup', async ({ kind }) => {
    if (kind === 'featured image') noMain();
    await mount(); const upload = deferred<{ id: string }>();
    mocks.uploadAsset.mockReturnValueOnce(upload.promise);
    await pickImage(0);
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
    expect(server().featuredAssetId).toBe('image');
  });

  it.each([{ kind: 'featured image' }, { kind: 'gallery image' }])('ignores $kind attachment completion after store navigation', async ({ kind }) => {
    if (kind === 'featured image') noMain();
    await mount(); const attachment = deferred<unknown>();
    if (kind === 'featured image') mocks.patch.mockReturnValueOnce(attachment.promise);
    else mocks.post.mockReturnValueOnce(attachment.promise);
    await pickImage(0); await flush();
    if (kind === 'featured image') expect(mocks.patch).toHaveBeenCalledWith('/products/p1', expect.objectContaining({ featuredAssetId: 'uploaded' }));
    else expect(mocks.post).toHaveBeenCalledWith('/products/p1/assets', { assetId: 'uploaded' });
    localStorage.setItem('sr_admin_store', 'second'); mocks.store = { slug: 'second', currency: 'USD' };
    await act(async () => { render(); }); await flush();
    await fill(title(), 'New store edit');
    const reads = mocks.get.mock.calls.length;
    await act(async () => { attachment.resolve({}); }); await flush();
    expect(title().value).toBe('New store edit'); expect(mocks.get).toHaveBeenCalledTimes(reads);
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledTimes(kind === 'featured image' ? 1 : 0);
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
