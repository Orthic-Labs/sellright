// @vitest-environment jsdom
// Issue #333: standard two-step sign-in. Step 1 is email + password only; the code step appears ONLY after the API
// verified the password of an account with 2FA; passkey autofill + a secondary passkey button.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

const caps = vi.fn(); let webauthn = true; let autofill = false;
const post = vi.fn();
const loginWithPasskey = vi.fn();
class ApiError extends Error {
  body?: Record<string, unknown>;
  constructor(public status: number, message: string, public code?: string, body?: Record<string, unknown>) { super(message); this.body = body; }
}
vi.mock('../api', () => ({ api: { post: (...a: unknown[]) => post(...a), get: async () => ({ storeName: 'Damned Designs', logoUrl: null, theme: null, fontFaces: [] }) }, auth: { store: null }, ApiError }));
vi.mock('../auth', () => ({ useAuth: () => ({ me: null, refresh: vi.fn() }) }));
vi.mock('../lib/passkeys', () => ({
  browserSupportsWebAuthn: () => webauthn, browserSupportsWebAuthnAutofill: async () => autofill,
  capabilities: () => caps(), loginWithPasskey: (...a: unknown[]) => loginWithPasskey(...a), passkeyErrorMessage: (e: Error) => e.message,
}));
const { default: Login } = await import('./Login');
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<MemoryRouter><Login /></MemoryRouter>); });
  await flush(); await flush();
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}
const buttons = (c: HTMLElement) => [...c.querySelectorAll('button')];
const has = (c: HTMLElement) => buttons(c).some((b) => b.textContent === 'Sign in with a passkey');
const codeField = (c: HTMLElement) => c.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement | null;
async function signIn(c: HTMLElement, email = 'owner@store.test', password = 'right password') {
  act(() => setInput(c.querySelector('input[type="email"]') as HTMLInputElement, email));
  act(() => setInput(c.querySelector('input[autocomplete="current-password"]') as HTMLInputElement, password));
  act(() => { (c.querySelector('form') as HTMLFormElement).requestSubmit(); });
  await flush(); await flush();
}

beforeEach(() => { webauthn = true; autofill = false; caps.mockReset(); post.mockReset(); loginWithPasskey.mockReset(); caps.mockResolvedValue({ passkeys: false }); });

describe('step 1: email and password only', () => {
  it('shows only email + password (with the right autocomplete), forgot link and a show/hide toggle — never a code field', async () => {
    const { container, done } = await render();
    expect(container.querySelectorAll('input:not([hidden])').length).toBe(2);
    expect(codeField(container)).toBeNull();
    expect(container.textContent).not.toMatch(/Optional|Authentication code/);
    expect(container.querySelector('input[type="email"]')!.getAttribute('autocomplete')).toBe('username webauthn');
    const pw = container.querySelector('input[autocomplete="current-password"]') as HTMLInputElement;
    expect(pw.type).toBe('password');
    act(() => { (container.querySelector('button[aria-label="Show password"]') as HTMLButtonElement).click(); });
    expect(pw.type).toBe('text');
    expect(container.querySelector('a[href="/forgot-password"]')!.textContent).toBe('Forgot password?');
    expect(container.textContent).toContain('Damned Designs');
    done();
  });

  it('an account without 2FA signs straight in after the password; no code step', async () => {
    post.mockResolvedValueOnce({ csrfToken: 'x', admin: { email: 'a@b.c' }, stores: [] });
    const assign = vi.fn(); Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
    const { container, done } = await render();
    await signIn(container);
    expect(post).toHaveBeenCalledWith('/login', { email: 'owner@store.test', password: 'right password' });
    expect(codeField(container)).toBeNull();
    expect(assign).toHaveBeenCalled();
    done();
  });

  it('a wrong password shows one generic error under the field and no code step', async () => {
    post.mockRejectedValueOnce(new ApiError(401, 'invalid email or password', 'INVALID_CREDENTIALS'));
    const { container, done } = await render();
    await signIn(container, 'owner@store.test', 'wrong');
    expect(codeField(container)).toBeNull();
    const pw = container.querySelector('input[autocomplete="current-password"]')!;
    expect(pw.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector(`#${pw.getAttribute('aria-describedby')}`)!.textContent).toBe('Incorrect email or password.');
    done();
  });

  it('rate limiting shows a visible message with the retry-after and disables Sign in', async () => {
    post.mockRejectedValueOnce(new ApiError(429, 'too many attempts — try again in 120s', 'RATE_LIMITED', { retryAfterSeconds: 120 }));
    const { container, done } = await render();
    await signIn(container);
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/Too many attempts.*Try again in 2:0\d/);
    expect((buttons(container).find((b) => b.textContent === 'Sign in') as HTMLButtonElement).disabled).toBe(true);
    done();
  });
});

describe('step 2: only after a correct password, only for 2FA accounts', () => {
  it('asks for the 6-digit code (one-time-code, numeric) and auto-submits at 6 digits with the challenge token', async () => {
    post.mockResolvedValueOnce({ twoFactorRequired: true, challengeToken: 'challenge-123', methods: ['totp', 'recovery_code'], expiresInSeconds: 300 });
    post.mockResolvedValueOnce({ csrfToken: 'x', admin: { email: 'a@b.c' }, stores: [] });
    const { container, done } = await render();
    await signIn(container);
    expect(container.textContent).toContain('Enter the 6-digit code from your authenticator app');
    const code = codeField(container)!;
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(container.querySelector('input[autocomplete="current-password"]')).toBeNull();
    expect(buttons(container).some((b) => b.textContent === 'Use a recovery code')).toBe(true);
    act(() => setInput(code, '12345'));
    expect(post).toHaveBeenCalledTimes(1);
    act(() => setInput(code, '123456'));
    await flush();
    expect(post).toHaveBeenLastCalledWith('/login/2fa', { challengeToken: 'challenge-123', code: '123456' });
    done();
  });

  it('a recovery code can be used instead', async () => {
    post.mockResolvedValueOnce({ twoFactorRequired: true, challengeToken: 'c2', methods: ['totp', 'recovery_code'] });
    post.mockRejectedValueOnce(new ApiError(401, 'nope', 'INVALID_CODE'));
    const { container, done } = await render();
    await signIn(container);
    act(() => { buttons(container).find((b) => b.textContent === 'Use a recovery code')!.click(); });
    const input = container.querySelector('input[autocomplete="off"]') as HTMLInputElement;
    act(() => setInput(input, 'abcd-efgh-ijkl-mnop'));
    act(() => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await flush();
    expect(post).toHaveBeenLastCalledWith('/login/2fa', { challengeToken: 'c2', code: 'abcd-efgh-ijkl-mnop' });
    expect(container.textContent).toContain('That recovery code didn’t work');
    done();
  });

  it('an expired challenge returns to step 1 with a clear message', async () => {
    post.mockResolvedValueOnce({ twoFactorRequired: true, challengeToken: 'c3', methods: ['totp', 'recovery_code'] });
    post.mockRejectedValueOnce(new ApiError(401, 'expired', 'LOGIN_CHALLENGE_EXPIRED'));
    const { container, done } = await render();
    await signIn(container);
    act(() => setInput(codeField(container)!, '111111'));
    await flush(); await flush();
    expect(codeField(container)).toBeNull();
    expect(container.textContent).toContain('Your sign-in timed out');
    done();
  });
});

describe('#333 review', () => {
  it('too many wrong codes returns to the password step with the exhausted message', async () => {
    post.mockResolvedValueOnce({ twoFactorRequired: true, challengeToken: 'c4', methods: ['totp', 'recovery_code'] });
    post.mockRejectedValueOnce(new ApiError(401, 'x', 'LOGIN_CHALLENGE_EXHAUSTED'));
    const { container, done } = await render();
    await signIn(container);
    act(() => setInput(codeField(container)!, '222222'));
    await flush(); await flush();
    expect(codeField(container)).toBeNull();
    expect(container.textContent).toContain('Too many incorrect codes. Enter your password again.');
    done();
  });

  it('focus returns to the code field after a wrong code', async () => {
    post.mockResolvedValueOnce({ twoFactorRequired: true, challengeToken: 'c5', methods: ['totp', 'recovery_code'] });
    post.mockRejectedValueOnce(new ApiError(401, 'x', 'INVALID_CODE'));
    const { container, done } = await render();
    await signIn(container);
    act(() => setInput(codeField(container)!, '333333'));
    await flush(); await flush();
    expect(document.activeElement).toBe(codeField(container));
    done();
  });

  it('a passkey-only account on a browser without passkeys goes straight to the recovery code', async () => {
    webauthn = false;
    post.mockResolvedValueOnce({ twoFactorRequired: true, challengeToken: 'c6', methods: ['passkey', 'recovery_code'] });
    const { container, done } = await render();
    await signIn(container);
    expect(container.textContent).toContain('Use a recovery code');
    expect(container.querySelector('input[autocomplete="off"]')).not.toBeNull();
    expect(buttons(container).some((b) => b.textContent === 'Use your passkey')).toBe(false);
    done();
  });
});

describe('passkeys', () => {
  it('"Sign in with a passkey" is a secondary button when the capability is on and the browser supports WebAuthn', async () => {
    caps.mockResolvedValue({ passkeys: true });
    const { container, done } = await render();
    expect(has(container)).toBe(true);
    expect(buttons(container).find((b) => b.textContent === 'Sign in with a passkey')!.className).toContain('auth-btn-secondary');
    done();
  });
  it('starts conditional mediation (autofill) when the browser supports it', async () => {
    caps.mockResolvedValue({ passkeys: true }); autofill = true;
    loginWithPasskey.mockReturnValue(new Promise(() => {}));
    const { done } = await render();
    expect(loginWithPasskey).toHaveBeenCalledWith({ useBrowserAutofill: true });
    done();
  });
  it('hidden when capability off', async () => {
    caps.mockResolvedValue({ passkeys: false });
    const { container, done } = await render();
    expect(has(container)).toBe(false);
    done();
  });
  it('hidden when browser lacks WebAuthn', async () => {
    webauthn = false; caps.mockResolvedValue({ passkeys: true });
    const { container, done } = await render();
    expect(has(container)).toBe(false);
    done();
  });
});
