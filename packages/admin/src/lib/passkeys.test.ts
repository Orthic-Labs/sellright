import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn(); const post = vi.fn(); const del = vi.fn();
class FakeApiError extends Error { code?: string; constructor(public status: number, m: string) { super(m); } }
vi.mock('../api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), del: (p: string) => del(p) }, ApiError: FakeApiError }));
const startAuthentication = vi.fn(); const startRegistration = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (a: unknown) => startAuthentication(a), startRegistration: (a: unknown) => startRegistration(a),
  browserSupportsWebAuthn: () => true,
}));

const pk = await import('./passkeys');

beforeEach(() => { vi.clearAllMocks(); });

describe('passkeys client', () => {
  it('capabilities: 404 / network error => false, true passes through', async () => {
    get.mockRejectedValueOnce(new FakeApiError(404, 'nope'));
    expect(await pk.capabilities()).toEqual({ passkeys: false });
    get.mockRejectedValueOnce(new TypeError('network'));
    expect(await pk.capabilities()).toEqual({ passkeys: false });
    get.mockResolvedValueOnce({ passkeys: true });
    expect(await pk.capabilities()).toEqual({ passkeys: true });
    expect(get).toHaveBeenCalledWith('/capabilities');
  });

  it('login: options -> modal start (never autofill) -> verify', async () => {
    const order: string[] = [];
    post.mockImplementation(async (p: string) => { order.push(p); return p.endsWith('options') ? { options: { challenge: 'c' } } : { csrfToken: 't', stores: [] }; });
    startAuthentication.mockImplementation(async () => { order.push('start'); return { id: 'cred' }; });
    const r = await pk.loginWithPasskey();
    expect(order).toEqual(['/passkeys/login/options', 'start', '/passkeys/login/verify']);
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    expect(post).toHaveBeenLastCalledWith('/passkeys/login/verify', { response: { id: 'cred' } });
    expect(r.csrfToken).toBe('t');
  });

  it('register: options -> start -> verify with label', async () => {
    post.mockImplementation(async (p: string) => (p.endsWith('options') ? { options: { challenge: 'r' } } : { id: '1', label: 'Phone' }));
    startRegistration.mockResolvedValue({ id: 'new' });
    await pk.registerPasskey('Phone');
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'r' } });
    expect(post).toHaveBeenLastCalledWith('/passkeys/register/verify', { response: { id: 'new' }, label: 'Phone' });
  });

  it('step-up: options -> start -> verify', async () => {
    post.mockImplementation(async (p: string) => (p.endsWith('options') ? { options: { challenge: 's' } } : { ok: true }));
    startAuthentication.mockResolvedValue({ id: 'x' });
    await pk.stepUpWithPasskey();
    expect(post.mock.calls.map((c) => c[0])).toEqual(['/step-up/passkey/options', '/step-up/passkey/verify']);
  });

  it('NotAllowedError => friendly cancel message, verify never called', async () => {
    post.mockResolvedValue({ options: {} });
    startAuthentication.mockRejectedValue(Object.assign(new Error('The operation either timed out or was not allowed'), { name: 'NotAllowedError' }));
    const e = await pk.loginWithPasskey().catch((x) => x);
    expect(e).toBeInstanceOf(pk.PasskeyError);
    expect(e.message).toBe(pk.CANCELLED_MESSAGE);
    expect(e.cancelled).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('error mapping by API code and step_up detection', () => {
    const t = new FakeApiError(409, 'raw'); t.code = 'LAST_SECOND_FACTOR';
    expect(pk.passkeyErrorMessage(t)).toMatch(/Add another passkey or an authenticator app/);
    expect(pk.defaultPasskeyLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(pk.defaultPasskeyLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(pk.isStepUpRequired(new FakeApiError(403, 'step_up_required'))).toBe(true);
    expect(pk.isStepUpRequired(new FakeApiError(403, 'other'))).toBe(false);
  });

  it('list and delete', async () => {
    get.mockResolvedValue({ items: [{ id: 'a' }] });
    expect(await pk.listPasskeys()).toEqual([{ id: 'a' }]);
    await pk.deletePasskey('a');
    expect(del).toHaveBeenCalledWith('/passkeys/a');
  });
});
