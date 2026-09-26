import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above top-level const/let declarations —
// vi.hoisted's callback runs first, so state a factory reads synchronously
// must be built there (see manifest/stock-hook.test.ts for the same pattern).
const { envMock, logInfo, errError } = vi.hoisted(() => ({
  envMock: {} as Record<string, string | undefined>,
  logInfo: vi.fn(),
  errError: vi.fn(),
}));

vi.mock('../env.js', () => ({ env: envMock }));
vi.mock('../lib/logger.js', () => ({ log: { info: (...a: unknown[]) => logInfo(...a) }, err: { error: (...a: unknown[]) => errError(...a) } }));

import { resolveCloudflareConfig, purgeCloudflareUrls } from './cloudflare-purge.js';

const fetchMock = vi.fn();

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  logInfo.mockClear();
  errError.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveCloudflareConfig', () => {
  it('is disabled (null) when neither zone id nor token is configured for the store', () => {
    expect(resolveCloudflareConfig('acme')).toBeNull();
  });

  it('is disabled when only one of zone id / token is set', () => {
    envMock.CLOUDFLARE_ZONE_ID = 'zone-1';
    expect(resolveCloudflareConfig('acme')).toBeNull();
  });

  it('uses the single-store fallback vars', () => {
    envMock.CLOUDFLARE_ZONE_ID = 'zone-1';
    envMock.CLOUDFLARE_API_TOKEN = 'token-1';
    expect(resolveCloudflareConfig('acme')).toEqual({ zoneId: 'zone-1', apiToken: 'token-1' });
  });

  it('prefers the per-store _BY_APP map over the fallback', () => {
    envMock.CLOUDFLARE_ZONE_ID = 'fallback-zone';
    envMock.CLOUDFLARE_API_TOKEN = 'fallback-token';
    envMock.CLOUDFLARE_ZONE_ID_BY_APP = 'acme=acme-zone,other=other-zone';
    envMock.CLOUDFLARE_API_TOKEN_BY_APP = 'acme=acme-token';
    expect(resolveCloudflareConfig('acme')).toEqual({ zoneId: 'acme-zone', apiToken: 'acme-token' });
  });

  it('is disabled for a store absent from the _BY_APP map with no fallback', () => {
    envMock.CLOUDFLARE_ZONE_ID_BY_APP = 'acme=acme-zone';
    envMock.CLOUDFLARE_API_TOKEN_BY_APP = 'acme=acme-token';
    expect(resolveCloudflareConfig('someone-else')).toBeNull();
  });
});

describe('purgeCloudflareUrls', () => {
  it('is a no-op (no fetch call) when the store has no Cloudflare config', async () => {
    await expect(purgeCloudflareUrls('acme', ['https://acme.example.com/'])).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the url list is empty, even if configured', async () => {
    envMock.CLOUDFLARE_ZONE_ID = 'zone-1';
    envMock.CLOUDFLARE_API_TOKEN = 'token-1';
    await expect(purgeCloudflareUrls('acme', [])).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the zone purge_cache endpoint with a bearer token and the file list', async () => {
    envMock.CLOUDFLARE_ZONE_ID = 'zone-1';
    envMock.CLOUDFLARE_API_TOKEN = 'token-1';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
    await expect(purgeCloudflareUrls('acme', ['https://acme.example.com/', 'https://acme.example.com/shop/'])).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache');
    expect(init.headers.authorization).toBe('Bearer token-1');
    expect(JSON.parse(init.body)).toEqual({ files: ['https://acme.example.com/', 'https://acme.example.com/shop/'] });
    expect(logInfo).toHaveBeenCalled();
  });

  it('chunks more than 30 urls into multiple purge_cache calls', async () => {
    envMock.CLOUDFLARE_ZONE_ID = 'zone-1';
    envMock.CLOUDFLARE_API_TOKEN = 'token-1';
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    const urls = Array.from({ length: 65 }, (_, i) => `https://acme.example.com/p/${i}`);
    await purgeCloudflareUrls('acme', urls);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 30 + 30 + 5
  });

  it('never throws on a non-2xx response — logs and swallows', async () => {
    envMock.CLOUDFLARE_ZONE_ID = 'zone-1';
    envMock.CLOUDFLARE_API_TOKEN = 'token-1';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ success: false, errors: ['bad token'] }) });
    await expect(purgeCloudflareUrls('acme', ['https://acme.example.com/'])).resolves.toBe(false);
    expect(errError).toHaveBeenCalled();
  });

  it('never throws when the network call itself rejects', async () => {
    envMock.CLOUDFLARE_ZONE_ID = 'zone-1';
    envMock.CLOUDFLARE_API_TOKEN = 'token-1';
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(purgeCloudflareUrls('acme', ['https://acme.example.com/'])).resolves.toBe(false);
    expect(errError).toHaveBeenCalled();
  });
});
