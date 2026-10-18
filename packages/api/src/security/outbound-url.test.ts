import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ interfaces: {} as Record<string, Array<{ address: string }>>, inventory: '' }));
vi.mock('node:os', () => ({ networkInterfaces: vi.fn(() => host.interfaces) }));
vi.mock('../env.js', () => ({ env: { get OUTBOUND_SELF_IPS() { return host.inventory; } } }));
import { assertSafeOutboundUrl, safeOutboundFetch } from './outbound-url.js';

beforeEach(() => { host.interfaces = {}; host.inventory = ''; });

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

  it.each([
    ['93.184.216.34', 'http://93.184.216.34:8443/hook'],
    ['93.184.216.34', 'https://[::ffff:93.184.216.34]:8443/hook'],
    ['::ffff:5db8:d822', 'https://93.184.216.34/hook'],
    ['2606:4700::1111', 'https://[2606:4700:0:0:0:0:0:1111]:9443/hook'],
  ])('rejects own interface literal %s before any request', async (address, url) => {
    host.interfaces = { eth0: [{ address }] };
    const request = vi.fn(async () => new Response('unreachable'));
    await expect(safeOutboundFetch(url, {}, { request })).rejects.toThrow(/this host/);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['93.184.216.34', '93.184.216.34', 4],
    ['93.184.216.34', '::ffff:5db8:d822', 6],
    ['::ffff:93.184.216.34', '93.184.216.34', 4],
    ['2606:4700::1111', '2606:4700:0:0:0:0:0:1111', 6],
  ] as const)('rejects any DNS answer matching operator inventory %s', async (inventory, address, family) => {
    host.inventory = inventory;
    const request = vi.fn(async () => new Response('unreachable'));
    await expect(safeOutboundFetch('https://merchant.example:8443/hook', {}, {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address, family }], request,
    })).rejects.toThrow(/this host/);
    expect(request).not.toHaveBeenCalled();
  });

  it('unions interfaces with operator inventory & refreshes them after DNS on every validation', async () => {
    host.inventory = '2606:4700::1111';
    const lookup = async () => {
      host.interfaces = { eth0: [{ address: '93.184.216.34' }] };
      return [{ address: '93.184.216.34', family: 4 }];
    };
    await expect(assertSafeOutboundUrl('https://merchant.example/hook', { lookup })).rejects.toThrow(/this host/);
    await expect(assertSafeOutboundUrl('https://[2606:4700::1111]/hook')).rejects.toThrow(/this host/);
    host.interfaces = {};
    await expect(assertSafeOutboundUrl('https://93.184.216.34/hook')).resolves.toBe('https://93.184.216.34/hook');
    host.interfaces = { eth1: [{ address: '93.184.216.34' }] };
    await expect(assertSafeOutboundUrl('https://93.184.216.34/hook')).rejects.toThrow(/this host/);
  });

  it('allows unrelated public HTTP(S) custom ports & pins their selected DNS address', async () => {
    host.interfaces = { eth0: [{ address: '2606:4700::1111' }] };
    host.inventory = '93.184.216.34';
    const seen: Array<{ port: string; address: string }> = [];
    for (const protocol of ['http', 'https']) {
      await safeOutboundFetch(`${protocol}://merchant.example:8443/hook`, {}, {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        request: async (url, _init, connect) => {
          connect.lookup('merchant.example', {}, (error, address) => {
            expect(error).toBeNull(); seen.push({ port: url.port, address });
          });
          return new Response('ok');
        },
      });
    }
    expect(seen).toEqual([{ port: '8443', address: '8.8.8.8' }, { port: '8443', address: '8.8.8.8' }]);
  });

  it('rejects a self redirect without making its connection', async () => {
    host.inventory = '93.184.216.34';
    const request = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://[::ffff:93.184.216.34]:8443/admin' } }));
    await expect(safeOutboundFetch('https://merchant.example/hook', {}, {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }], request,
    })).rejects.toThrow(/this host/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps public redirects denied after validating their destination', async () => {
    const request = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example:8443/hook' } }));
    await expect(safeOutboundFetch('https://merchant.example/hook', {}, {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }], request,
    })).rejects.toThrow(/redirects are not allowed/);
    expect(request).toHaveBeenCalledTimes(1);
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
