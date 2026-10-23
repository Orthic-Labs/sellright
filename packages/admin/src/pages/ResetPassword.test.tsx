// @vitest-environment jsdom
// #333 review: a dead reset link never shows the form — one primary "Send a new link" and a "Back to sign in" link.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

const post = vi.fn();
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../api', () => ({ api: { post: (...a: unknown[]) => post(...a), get: async () => ({ storeName: 'Rotten Hand', logoUrl: null, theme: null, fontFaces: [] }) }, ApiError }));
const { default: ResetPassword } = await import('./ResetPassword');
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function render(url: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<MemoryRouter initialEntries={[url]}><ResetPassword /></MemoryRouter>); });
  await flush(); await flush();
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}

beforeEach(() => post.mockReset());

describe('ResetPassword', () => {
  it('a dead link: no form, one primary "Send a new link", and "Back to sign in"', async () => {
    post.mockResolvedValueOnce({ valid: false });
    const { container, done } = await render('/reset-password?token=dead-token-0123456789');
    expect(post).toHaveBeenCalledWith('/password/reset/check', { token: 'dead-token-0123456789' });
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('This link has expired');
    const primaries = [...container.querySelectorAll('.auth-btn-primary')];
    expect(primaries.map((a) => a.textContent)).toEqual(['Send a new link']);
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === 'Back to sign in')).toBe(true);
    done();
  });

  it('a live link shows the form; the reset posts the token and the new password', async () => {
    post.mockResolvedValueOnce({ valid: true }).mockResolvedValueOnce({ ok: true });
    const { container, done } = await render('/reset-password?token=live-token-0123456789');
    const [pw, confirm] = [...container.querySelectorAll('input[autocomplete="new-password"]')] as HTMLInputElement[];
    const set = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    act(() => { set(pw!, 'a-new-password-1'); set(confirm!, 'a-new-password-1'); });
    act(() => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await flush();
    expect(post).toHaveBeenLastCalledWith('/password/reset', { token: 'live-token-0123456789', password: 'a-new-password-1' });
    expect(container.textContent).toContain('Password updated');
    done();
  });
});
