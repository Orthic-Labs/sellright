import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; vi.resetModules(); });

describe('multi-host Cloudflare purge env', () => {
  it('is undefined when unset or empty', async () => {
    delete process.env.STOREFRONT_HOSTS_BY_STORE;
    process.env.CLOUDFLARE_ZONE_ID_BY_HOST = '';
    const { env } = await import('./env.js');
    expect(env.STOREFRONT_HOSTS_BY_STORE).toBeUndefined();
    expect(env.CLOUDFLARE_ZONE_ID_BY_HOST).toBeUndefined();
  });
  it('passes the raw strings through', async () => {
    process.env.STOREFRONT_HOSTS_BY_STORE = 'rightsites=a.com|b.cc';
    process.env.CLOUDFLARE_ZONE_ID_BY_HOST = 'a.com=z1,b.cc=z2';
    const { env } = await import('./env.js');
    expect(env.STOREFRONT_HOSTS_BY_STORE).toBe('rightsites=a.com|b.cc');
    expect(env.CLOUDFLARE_ZONE_ID_BY_HOST).toBe('a.com=z1,b.cc=z2');
  });
});
