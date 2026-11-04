// @vitest-environment jsdom
// #355 phase 3, target side: the admin approves saving this account to a hub; a stale sign-in asks for a new one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

const post = vi.fn();
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../api', () => ({ api: { post: (...a: unknown[]) => post(...a), get: async () => ({ storeName: 'Rotten Hand', logoUrl: null, theme: null, fontFaces: [] }) }, ApiError }));
vi.mock('../auth', () => ({ useAuth: () => ({ loading: false, me: { email: 'owner@rotten.test' } }) }));
const { default: Handoff } = await import('./Handoff');
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const QUERY = '?client_id=hub&redirect_uri=https%3A%2F%2Fhub.example%2Fv1%2Fhub%2Fcallback%2Fshop&state=s-0123456789abcdef&code_challenge=c-challenge&code_challenge_method=S256';

async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', `/handoff${QUERY}`);
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<MemoryRouter initialEntries={[`/handoff${QUERY}`]}><Handoff /></MemoryRouter>); });
  await flush(); await flush();
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}
const button = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent === text)!;

beforeEach(() => { post.mockReset(); sessionStorage.clear(); });

describe('Handoff', () => {
  it('names the account and the hub, and approves with exactly the hub parameters', async () => {
    post.mockResolvedValueOnce({ redirectTo: 'https://hub.example/v1/hub/callback/shop?code=x' });
    const { container, done } = await render();
    expect(container.textContent).toContain('owner@rotten.test');
    expect(container.textContent).toContain('hub.example');
    await act(async () => { button(container, 'Save account').click(); });
    await flush();
    expect(post).toHaveBeenCalledWith('/handoff/authorize', { clientId: 'hub', redirectUri: 'https://hub.example/v1/hub/callback/shop',
      state: 's-0123456789abcdef', codeChallenge: 'c-challenge', codeChallengeMethod: 'S256' });
    expect(sessionStorage.getItem('sr_handoff_pending')).toBeNull();
    done();
  });

  it('a sign-in older than ten minutes asks to sign in again and keeps the request for afterwards', async () => {
    post.mockRejectedValueOnce(new ApiError(403, 'sign in again', 'STEP_UP_REQUIRED'));
    const { container, done } = await render();
    await act(async () => { button(container, 'Save account').click(); });
    await flush();
    expect(container.textContent).toContain('sign in again to approve');
    expect(button(container, 'Sign in again')).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem('sr_handoff_pending')!).client_id).toBe('hub');
    done();
  });

  it('an unregistered hub shares nothing', async () => {
    post.mockRejectedValueOnce(new ApiError(400, 'unknown', 'HANDOFF_UNKNOWN_CLIENT'));
    const { container, done } = await render();
    await act(async () => { button(container, 'Save account').click(); });
    await flush();
    expect(container.textContent).toContain('Nothing was shared');
    expect(button(container, 'Save account').disabled).toBe(true);
    done();
  });
});
