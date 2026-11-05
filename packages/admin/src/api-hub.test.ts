// @vitest-environment jsdom
// #355 phase 3: with a saved account active in this tab, every admin call goes through this server's hub relay with
// the hub CSRF token; a relayed 401 drops the saved account instead of bouncing to this server's sign-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, hub, hubApi } from './api';

const calls: Array<{ url: string; init: RequestInit }> = [];
let status = 200;
let reply: unknown = {};

beforeEach(() => {
  calls.length = 0; status = 200; reply = {};
  sessionStorage.clear(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const header = (i: number, name: string) => (calls[i]!.init.headers as Record<string, string>)[name];

describe('admin API with a saved account (#355)', () => {
  it('uses this server directly when no saved account is active', async () => {
    await api.get('/orders?status=open');
    expect(calls[0]!.url).toBe('/v1/admin/orders?status=open');
  });

  it('relays through the hub with the hub CSRF token and never the admin CSRF token', async () => {
    hub.slot = '0b6c3d1e-1111-4222-8333-944455556666';
    hub.csrf = 'a'.repeat(32);
    document.cookie = 'sr_csrf=admin-token';
    await api.get('/me');
    await api.put('/preferences/x', { value: 1 });
    expect(calls[0]!.url).toBe('/v1/hub/accounts/0b6c3d1e-1111-4222-8333-944455556666/admin/me');
    expect(calls[1]!.url).toBe('/v1/hub/accounts/0b6c3d1e-1111-4222-8333-944455556666/admin/preferences/x');
    expect(header(1, 'x-hub-csrf')).toBe('a'.repeat(32));
    expect(header(1, 'x-csrf-token')).toBeUndefined();
  });

  it('a relayed 401 forgets the active saved account for this tab', async () => {
    hub.slot = '0b6c3d1e-1111-4222-8333-944455556666';
    status = 401; reply = { error: { code: 'HUB_SLOT_REAUTH', message: 'sign in again' } };
    await expect(api.get('/me')).rejects.toMatchObject({ status: 401, code: 'HUB_SLOT_REAUTH' });
    expect(hub.slot).toBeNull();
  });

  it('loading saved accounts keeps the hub CSRF token for this tab', async () => {
    reply = { csrf: 'b'.repeat(32), targets: [], accounts: [] };
    await hubApi.load();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['POST /v1/hub/session', 'GET /v1/hub/accounts']);
    expect(hub.csrf).toBe('b'.repeat(32));
  });
});
