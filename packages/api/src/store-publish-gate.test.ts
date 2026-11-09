import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { storePublishGate } from './store-publish-gate.js';
import { generatePreviewToken, hashPreviewToken, StoreNotPublishedError } from './store-publish.js';

const token = generatePreviewToken();
const unpublished = { published: false, previewTokenHash: hashPreviewToken(token) };

function build(config: unknown, resolve = vi.fn(async () => ({ config }) as never)) {
  const app = new Hono();
  app.onError((err, c) => { return c.json({ error: err.message }, err instanceof StoreNotPublishedError ? 404 : 500); });
  app.use('/v1/shop/*', storePublishGate(resolve));
  app.all('/v1/shop/*', (c) => c.json({ ok: true }));
  return { app, resolve };
}

describe('storePublishGate', () => {
  it('lets every request through for a published store', async () => {
    const { app } = build({});
    expect((await app.request('/v1/shop/catalog/products')).status).toBe(200);
    expect((await app.request('/v1/shop/cart', { method: 'POST' })).status).toBe(200);
  });

  it('answers 404 for reads and writes on an unpublished store without a token', async () => {
    const { app } = build(unpublished);
    expect((await app.request('/v1/shop/catalog/products')).status).toBe(404);
    expect((await app.request('/v1/shop/cart', { method: 'POST' })).status).toBe(404);
  });

  it('accepts the preview token from the header or the query string', async () => {
    const { app } = build(unpublished);
    expect((await app.request('/v1/shop/catalog/products', { headers: { 'x-preview-token': token } })).status).toBe(200);
    expect((await app.request(`/v1/shop/catalog/products?preview_token=${token}`)).status).toBe(200);
    expect((await app.request('/v1/shop/catalog/products', { headers: { 'x-preview-token': 'wrong' } })).status).toBe(404);
  });

  it('accepts the token from the sr_preview_token cookie and rejects a wrong or empty one', async () => {
    const { app } = build(unpublished);
    const withCookie = (cookie: string) => app.request('/v1/shop/catalog/products', { headers: { cookie } });
    expect((await withCookie(`sr_preview_token=${token}`)).status).toBe(200);
    expect((await withCookie(`a=b; sr_preview_token=${encodeURIComponent(token)}; c=d`)).status).toBe(200);
    expect((await withCookie('sr_preview_token=wrong')).status).toBe(404);
    expect((await withCookie('sr_preview_token=')).status).toBe(404);
    expect((await withCookie(`other_sr_preview_token=${token}`)).status).toBe(404);
  });

  it('leaves /v1/shop/config to its own check', async () => {
    const { app, resolve } = build(unpublished);
    expect((await app.request('/v1/shop/config')).status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('defers to the route when the store cannot be resolved', async () => {
    const { app } = build(unpublished, vi.fn(async () => { throw new Error('unknown store'); }));
    expect((await app.request('/v1/shop/catalog/products')).status).toBe(200);
  });
});
