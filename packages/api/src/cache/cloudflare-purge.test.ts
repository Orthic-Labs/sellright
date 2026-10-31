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

import { resolveCloudflareConfig, purgeCloudflareUrls, purgeCloudflareHosts, storeHosts, zoneForHost } from './cloudflare-purge.js';

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

describe('purgeCloudflareHosts', () => {
  it('posts { hosts } once and reports success', async () => {
    envMock.CLOUDFLARE_ZONE_ID = 'z'; envMock.CLOUDFLARE_API_TOKEN = 't';
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    await expect(purgeCloudflareHosts('acme', ['a.example.com', 'a.example.com'])).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ hosts: ['a.example.com'] });
  });
  it('is false (and never throws) on rejection, network error or missing config', async () => {
    await expect(purgeCloudflareHosts('acme', ['a.example.com'])).resolves.toBe(false);
    envMock.CLOUDFLARE_ZONE_ID = 'z'; envMock.CLOUDFLARE_API_TOKEN = 't';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ success: false, errors: [] }) });
    await expect(purgeCloudflareHosts('acme', ['a.example.com'])).resolves.toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('net'));
    await expect(purgeCloudflareHosts('acme', ['a.example.com'])).resolves.toBe(false);
    expect(errError).toHaveBeenCalledTimes(2);
  });
});

describe('multi-host / multi-zone store', () => {
  const HOSTS = ['store.heardright.app', 'store.viewright.cc', 'buy.coderight.cc', 'get.scraperight.cc', 'store.coderight.cc'];
  const setup = () => {
    envMock.CLOUDFLARE_API_TOKEN = 'tok';
    envMock.STOREFRONT_HOSTS_BY_STORE = `rightsites=${HOSTS.join('|')}`;
    envMock.CLOUDFLARE_ZONE_ID_BY_HOST = 'store.heardright.app=zH,store.viewright.cc=zV,buy.coderight.cc=zC,store.coderight.cc=zC,get.scraperight.cc=zS';
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  };
  const calls = () => fetchMock.mock.calls.map(([u, i]) => ({ zone: String(u).split('/zones/')[1]!.split('/')[0], body: JSON.parse(i.body), auth: i.headers.authorization }));

  it('parses the host list and per-host zones (case/whitespace tolerant, ignores other stores)', () => {
    envMock.STOREFRONT_HOSTS_BY_STORE = 'rightsites= A.example.com | b.example.com |,other=x.com';
    envMock.CLOUDFLARE_ZONE_ID_BY_HOST = 'A.Example.com=z1, b.example.com=z2';
    expect(storeHosts('rightsites')).toEqual(['a.example.com', 'b.example.com']);
    expect(storeHosts('other')).toEqual(['x.com']);
    expect(storeHosts('acme')).toEqual([]);
    expect(zoneForHost('a.example.com')).toBe('z1');
    expect(zoneForHost('c.example.com')).toBeUndefined();
  });

  it('fans each path out to every host, one call per zone, same token', async () => {
    setup();
    await expect(purgeCloudflareUrls('rightsites', ['https://store.heardright.app/', 'https://store.heardright.app/shop/'])).resolves.toBe(true);
    const c = calls();
    expect(c.map((x) => x.zone).sort()).toEqual(['zC', 'zH', 'zS', 'zV']);
    expect(c.every((x) => x.auth === 'Bearer tok')).toBe(true);
    const by = Object.fromEntries(c.map((x) => [x.zone, x.body.files]));
    expect(by.zH).toEqual(['https://store.heardright.app/', 'https://store.heardright.app/shop/']);
    expect(by.zC).toHaveLength(4); // two coderight hosts x two paths share one zone call
    expect(by.zC).toContain('https://buy.coderight.cc/shop/');
    expect(by.zS).toEqual(['https://get.scraperight.cc/', 'https://get.scraperight.cc/shop/']);
  });

  it('batches per zone and reports false if any zone call fails', async () => {
    setup();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ success: false }) });
    const urls = Array.from({ length: 31 }, (_, i) => `https://store.heardright.app/p/${i}`);
    await expect(purgeCloudflareUrls('rightsites', urls)).resolves.toBe(false);
    // 31 urls on zH -> 2 calls; zV, zS -> 2 calls each; zC (2 hosts) -> 62 urls -> 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(2 + 2 + 2 + 3);
    expect(errError).toHaveBeenCalled();
  });

  it('host-purge fallback fans out to all hosts, grouped per zone', async () => {
    setup();
    await expect(purgeCloudflareHosts('rightsites', ['store.heardright.app'])).resolves.toBe(true);
    const by = Object.fromEntries(calls().map((x) => [x.zone, x.body.hosts]));
    expect(Object.keys(by).sort()).toEqual(['zC', 'zH', 'zS', 'zV']);
    expect(by.zC.sort()).toEqual(['buy.coderight.cc', 'store.coderight.cc']);
  });

  it('works with no default zone when every host is mapped; unmapped host fails without a call', async () => {
    setup();
    expect(resolveCloudflareConfig('rightsites')).toEqual({ zoneId: '', apiToken: 'tok' });
    envMock.STOREFRONT_HOSTS_BY_STORE = 'rightsites=a.example.com|b.example.com';
    envMock.CLOUDFLARE_ZONE_ID_BY_HOST = 'a.example.com=zA';
    await expect(purgeCloudflareUrls('rightsites', ['https://a.example.com/'])).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never logs the token', async () => {
    setup();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ success: false, errors: [] }) });
    await purgeCloudflareUrls('rightsites', ['https://store.heardright.app/']);
    expect(JSON.stringify([logInfo.mock.calls, errError.mock.calls])).not.toContain('tok"');
  });

  it('single-host store (new vars unset) sends exactly one unchanged request', async () => {
    envMock.CLOUDFLARE_ZONE_ID = 'zone-1'; envMock.CLOUDFLARE_API_TOKEN = 'token-1';
    envMock.STOREFRONT_HOSTS_BY_STORE = 'rightsites=a.example.com|b.example.com'; // other store's list must not leak
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    await purgeCloudflareUrls('acme', ['https://acme.example.com/']);
    await purgeCloudflareHosts('acme', ['acme.example.com']);
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i.body])).toEqual([
      ['https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache', '{"files":["https://acme.example.com/"]}'],
      ['https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache', '{"hosts":["acme.example.com"]}'],
    ]);
  });
});
