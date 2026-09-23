// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleIndexNowWebhook } from './indexnow-webhook.server';

const config = { host: 'fixture.example', key: 'fixture-key-123', secret: 'fixture-webhook-secret', storeId: 'fixture-store' };
const event = { id: 'delivery-1', topic: 'catalog.product_changed', payload: { storeId: config.storeId, productId: 'product-1', slug: 'a & b' } };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function request(body = JSON.stringify(event), headers: Record<string, string> = {}) {
  return new Request('https://fixture.example/indexnow/', { method: 'POST', body, headers: {
    'x-sr-topic': event.topic, 'x-sr-signature': createHmac('sha256', config.secret).update(body).digest('hex'), ...headers,
  } });
}

describe('signed catalog IndexNow consumer', () => {
  it('wires runtime environment through the Qwik POST route and forwards the response', async () => {
    vi.resetModules();
    // Only INDEXNOW_HOST is env now — the key VALUE comes from the backend
    // (GET /v1/shop/seo/indexnow-key.txt), never INDEXNOW_KEY/_LOCATION env vars.
    for (const [name, value] of Object.entries({ INDEXNOW_HOST: config.host,
      INDEXNOW_WEBHOOK_SECRET: config.secret, INDEXNOW_STORE_ID: config.storeId })) vi.stubEnv(name, value);
    // One shared fetch mock backs both the backend key lookup and the
    // eventual indexnow.org submission — discriminate by URL.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('indexnow-key.txt')) return new Response(config.key, { status: 200 });
      return new Response('', { status: 202 });
    }));
    const { onPost } = await import('../routes/indexnow/index');
    const send = vi.fn();
    await onPost({ request: request(), send } as unknown as Parameters<typeof onPost>[0]);
    const response = send.mock.calls[0]![0] as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, submitted: 1, status: 202 });
    send.mockClear();
    await onPost({ request: request(undefined, { 'x-sr-signature': 'bad' }), send } as unknown as Parameters<typeof onPost>[0]);
    expect((send.mock.calls[0]![0] as Response).status).toBe(403);
  });
  it.each([200, 202])('accepts provider %i and constructs only the configured host URL', async status => {
    const submit = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    expect((await handleIndexNowWebhook(request(), config, submit)).status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
    expect(JSON.parse(submit.mock.calls[0]![1]!.body as string)).toEqual({ host: config.host, key: config.key,
      keyLocation: 'https://fixture.example/fixture-key-123.txt', urlList: ['https://fixture.example/products/a%20%26%20b/'] });
  });
  it('rejects missing configuration, forged signatures, foreign stores and topics without submitting', async () => {
    const submit = vi.fn<typeof fetch>();
    expect((await handleIndexNowWebhook(request(), { ...config, secret: undefined }, submit)).status).toBe(503);
    expect((await handleIndexNowWebhook(request(), { ...config, keyLocation: 'https://foreign.example/key' }, submit)).status).toBe(503);
    expect((await handleIndexNowWebhook(request(undefined, { 'x-sr-signature': '0'.repeat(64) }), config, submit)).status).toBe(403);
    expect((await handleIndexNowWebhook(request(JSON.stringify({ ...event, payload: { ...event.payload, storeId: 'other' } })), config, submit)).status).toBe(403);
    expect((await handleIndexNowWebhook(request(undefined, { 'x-sr-topic': 'order.paid' }), config, submit)).status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });
  it('bounds body size and rejects malformed content and dot segments', async () => {
    const submit = vi.fn<typeof fetch>();
    expect((await handleIndexNowWebhook(request('x'.repeat(17000)), config, submit)).status).toBe(413);
    expect((await handleIndexNowWebhook(request('not-json'), config, submit)).status).toBe(400);
    expect((await handleIndexNowWebhook(request(JSON.stringify({ ...event, payload: { ...event.payload, slug: '..' } })), config, submit)).status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });
  it.each([204, 403, 429, 500])('returns retryable failure for provider %i', async status => {
    const submit = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    expect((await handleIndexNowWebhook(request(), config, submit)).status).toBe(502);
  });
  it('returns retryable failure on transport errors without leaking details', async () => {
    const response = await handleIndexNowWebhook(request(), config, vi.fn<typeof fetch>().mockRejectedValue(new Error('private detail')));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private detail');
  });
});
