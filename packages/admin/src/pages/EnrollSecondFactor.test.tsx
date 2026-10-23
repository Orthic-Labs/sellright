// @vitest-environment jsdom
// Issue #333: mandatory enrolment offers a passkey first (recommended), the authenticator app second; a first passkey
// shows the one-time recovery codes; Sign out is a text link.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const refresh = vi.fn(); const logout = vi.fn(); const reg = vi.fn();
vi.mock('../api', () => ({ api: { post: vi.fn(), get: async () => ({ storeName: 'Rotten Hand', logoUrl: null, theme: null, fontFaces: [] }) }, ApiError: class extends Error {} }));
vi.mock('../auth', () => ({ useAuth: () => ({ me: { email: 'owner@rh.test' }, refresh, logout }) }));
vi.mock('../lib/passkeys', () => ({
  browserSupportsWebAuthn: () => true, capabilities: async () => ({ passkeys: true }), defaultPasskeyLabel: () => 'Mac',
  isStepUpRequired: () => false, passkeyErrorMessage: (e: Error) => e.message, registerPasskey: (l: string) => reg(l),
}));
const { default: EnrollSecondFactor } = await import('./EnrollSecondFactor');
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<EnrollSecondFactor />); });
  await flush(); await flush();
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}
const btn = (c: HTMLElement, t: string) => [...c.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement;

beforeEach(() => { reg.mockReset(); refresh.mockReset(); });

describe('EnrollSecondFactor', () => {
  it('offers the passkey first and recommended, the authenticator app as the alternative, and Sign out as a link', async () => {
    const { container, done } = await mount();
    const sections = [...container.querySelectorAll('section')];
    expect(sections[0]!.textContent).toContain('Set up a passkey');
    expect(sections[0]!.textContent).toContain('Recommended');
    expect(sections[1]!.textContent).toContain('Use an authenticator app instead');
    expect(btn(container, 'Set up a passkey').className).toContain('auth-btn-primary');
    expect(btn(container, 'Set up an authenticator app').className).toContain('auth-btn-secondary');
    expect(btn(container, 'Sign out').className).toContain('auth-link');
    done();
  });

  it('a first passkey shows the recovery codes, then continues to the admin', async () => {
    reg.mockResolvedValue({ id: 'p', label: 'Mac', recoveryCodes: ['aaaa-bbbb-cccc-dddd'] });
    const { container, done } = await mount();
    act(() => { btn(container, 'Set up a passkey').click(); });
    await flush(); await flush();
    expect(reg).toHaveBeenCalledWith('Mac');
    expect(container.querySelector('[aria-label="Recovery codes"]')!.textContent).toContain('aaaa-bbbb-cccc-dddd');
    act(() => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    act(() => { btn(container, 'Continue to admin').click(); });
    expect(refresh).toHaveBeenCalled();
    done();
  });
});
