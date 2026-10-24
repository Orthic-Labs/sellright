import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('~/sellright/client', () => ({ sellright: () => ({ GET: api.get }) }));
import { bootstrapCustomer } from './bootstrap.server';

beforeEach(() => { api.get.mockReset(); });
describe('SSR customer adoption before rendering', () => {
  it('forwards every secure adoption cookie without replacing original legacy cookie', async () => {
    const cookies = ['sr_cust=opaque; HttpOnly; Secure; SameSite=Lax; Path=/', 'sr_cust_csrf=csrf; Secure; Path=/', 'authToken=; Max-Age=0; Path=/'];
    api.get.mockResolvedValue({ data: { id: 'exact-api-customer' }, response: { headers: { getSetCookie: () => cookies } } });
    const appended: string[] = [];
    expect(await bootstrapCustomer({ append: (name, value) => { expect(name).toBe('Set-Cookie'); appended.push(value); } })).toEqual({ id: 'exact-api-customer' });
    expect(appended).toEqual(cookies);
    expect(appended.some(value => value.startsWith('__vendure_session='))).toBe(false);
    expect(api.get).toHaveBeenCalledWith('/v1/shop/auth/me');
  });
  it('does not turn rejected, empty or unavailable auth into an authenticated render', async () => {
    const append = vi.fn();
    for (const error of [Object.assign(new Error('revoked'), { status: 401 }), new Error('unavailable')]) {
      api.get.mockRejectedValueOnce(error);
      await expect(bootstrapCustomer({ append })).rejects.toBe(error);
    }
    api.get.mockResolvedValueOnce({ data: null, response: { headers: { getSetCookie: () => [] } } });
    await expect(bootstrapCustomer({ append })).rejects.toThrow('Empty auth bootstrap response');
    expect(append).not.toHaveBeenCalled();
  });
  it('shares one read per request through the request sharedMap, and only within it', async () => {
    api.get.mockResolvedValue({ data: { id: 'c1' }, response: { headers: { getSetCookie: () => ['sr_cust=x; Path=/'] } } });
    const append = vi.fn();
    const request = new Map<string, unknown>();
    const [a, b] = await Promise.all([bootstrapCustomer({ append }, request), bootstrapCustomer({ append }, request)]);
    expect(a).toEqual({ id: 'c1' });
    expect(b).toBe(a);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    await bootstrapCustomer({ append }, new Map());
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
