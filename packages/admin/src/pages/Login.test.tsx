// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

const caps = vi.fn(); let webauthn = true;
vi.mock('../api', () => ({ api: { post: vi.fn() }, auth: { store: null } }));
vi.mock('../auth', () => ({ useAuth: () => ({ me: null, refresh: vi.fn() }) }));
vi.mock('../lib/passkeys', () => ({
  browserSupportsWebAuthn: () => webauthn, browserSupportsWebAuthnAutofill: async () => false,
  capabilities: () => caps(), loginWithPasskey: vi.fn(), passkeyErrorMessage: (e: Error) => e.message,
}));
const { default: Login } = await import('./Login');
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<MemoryRouter><Login /></MemoryRouter>); });
  await flush(); await flush();
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}
const has = (c: HTMLElement) => [...c.querySelectorAll('button')].some((b) => b.textContent === 'Use a passkey');

beforeEach(() => { webauthn = true; caps.mockReset(); });

describe('Login passkey button', () => {
  it('shows when capability on and browser supports WebAuthn', async () => {
    caps.mockResolvedValue({ passkeys: true });
    const { container, done } = await render();
    expect(has(container)).toBe(true);
    expect(container.querySelector('input[type="email"]')!.getAttribute('autocomplete')).toBe('username webauthn');
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
