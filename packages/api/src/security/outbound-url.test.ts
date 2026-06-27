import { describe, expect, it } from 'vitest';
import { assertSafeOutboundUrl, safeOutboundFetch } from './outbound-url.js';

describe('assertSafeOutboundUrl', () => {
  it('accepts public http and https urls', async () => {
    await expect(assertSafeOutboundUrl('https://example.com/hooks', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).resolves.toBe('https://example.com/hooks');
  });

  it('rejects non-http schemes', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toThrow(/http/);
  });

  it('rejects localhost and private address literals', async () => {
    await expect(assertSafeOutboundUrl('http://localhost:9000')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('http://127.0.0.1:9000')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('http://10.0.0.5/hook')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('http://[::1]/hook')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('http://[::ffff:7f00:1]/hook')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('http://[0:0:0:0:0:ffff:7f00:1]/hook')).rejects.toThrow(/private/);
  });

  it('rejects public hostnames that resolve to private addresses', async () => {
    await expect(assertSafeOutboundUrl('https://merchant.example/hook', {
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    })).rejects.toThrow(/private/);
  });

  it('pins the validated DNS address into the outbound request', async () => {
    const seen: string[] = [];
    const response = await safeOutboundFetch('https://merchant.example/hook', {}, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (_url, _init, connect) => {
        await new Promise<void>((resolve, reject) => {
          connect.lookup('merchant.example', {}, (err, address) => {
            if (err) reject(err);
            else {
              seen.push(String(address));
              resolve();
            }
          });
        });
        return new Response('ok', { status: 200 });
      },
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual(['93.184.216.34']);
  });

  it('rejects redirects to private hosts before following them', async () => {
    let requests = 0;
    await expect(safeOutboundFetch('https://merchant.example/hook', {}, {
      lookup: async (hostname) => hostname === 'merchant.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
      request: async () => {
        requests++;
        return new Response('', {
          status: 302,
          headers: { location: 'http://localhost/admin' },
        });
      },
    })).rejects.toThrow(/private/);

    expect(requests).toBe(1);
  });
});
