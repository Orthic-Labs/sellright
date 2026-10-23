// @vitest-environment jsdom
// Issue #333: authenticator enrolment — QR from the API, code-only confirmation for a fresh session (password only when
// the API asks for it), the button stays disabled until 6 digits, then the one-time recovery codes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

let passwordRequired = false;
const post = vi.fn(async (path: string, _body?: unknown) => {
  if (path === '/2fa/setup') return { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Store:me%40x.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Store', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', issuer: 'Store', account: 'me@x.test', passwordRequired };
  if (path === '/2fa/enable') return { enabled: true, recoveryCodes: ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'] };
  throw new Error(`unexpected ${path}`);
});
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../api', () => ({ api: { post: (p: string, b?: unknown) => post(p, b) }, ApiError }));

const { TwoFactorEnroll } = await import('./TwoFactorEnroll');

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const buttonByText = (c: HTMLElement, t: string) => [...c.querySelectorAll('button')].find((b) => b.textContent?.includes(t)) as HTMLButtonElement;

async function mount(onDone = vi.fn()) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<TwoFactorEnroll onDone={onDone} />); });
  act(() => { buttonByText(container, 'Set up an authenticator app').click(); });
  await flush();
  return { container, onDone, done: () => { act(() => root.unmount()); container.remove(); } };
}

beforeEach(() => { post.mockClear(); passwordRequired = false; });

describe('TwoFactorEnroll', () => {
  it('shows the QR and the key grouped in fours; Enable turns on at 6 digits; the code alone enables; recovery codes once', async () => {
    const { container, onDone, done } = await mount();
    try {
      expect(container.querySelector('.auth-qr img')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;utf8,/);
      expect(container.querySelector('[aria-label="Setup key"]')!.textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
      expect(container.querySelector('a[href^="otpauth://"]')!.textContent).toBe('Open in authenticator app');
      const code = container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
      expect(code.getAttribute('inputmode')).toBe('numeric');
      expect(container.querySelector('input[type="password"]')).toBeNull();
      const enable = buttonByText(container, 'Enable');
      act(() => setInput(code, '12345'));
      expect(enable.disabled).toBe(true);
      act(() => setInput(code, '123456'));
      expect(enable.disabled).toBe(false);
      act(() => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
      await flush();
      expect(post).toHaveBeenCalledWith('/2fa/enable', { code: '123456' });
      expect([...container.querySelectorAll('[aria-label="Recovery codes"] li')].map((li) => li.textContent)).toEqual(['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh']);
      const finish = buttonByText(container, 'Done');
      expect(finish.disabled).toBe(true);
      act(() => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
      act(() => { finish.click(); });
      expect(onDone).toHaveBeenCalled();
    } finally { done(); }
  });

  it('asks for the current password when the session is not fresh', async () => {
    passwordRequired = true;
    const { container, done } = await mount();
    try {
      act(() => setInput(container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement, '654321'));
      expect(buttonByText(container, 'Enable').disabled).toBe(true);
      act(() => setInput(container.querySelector('input[autocomplete="current-password"]') as HTMLInputElement, 'my-current-pass'));
      act(() => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
      await flush();
      expect(post).toHaveBeenCalledWith('/2fa/enable', { code: '654321', password: 'my-current-pass' });
    } finally { done(); }
  });
});
