// @vitest-environment jsdom
// P1b: TOTP enrolment component — enable re-proves the current password and shows the one-time recovery codes.
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const post = vi.fn(async (path: string, _body?: unknown) => {
  if (path === '/2fa/setup') return { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x' };
  if (path === '/2fa/enable') return { enabled: true, recoveryCodes: ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'] };
  throw new Error(`unexpected ${path}`);
});
vi.mock('../api', () => ({ api: { post: (p: string, b?: unknown) => post(p, b) } }));

const { TwoFactorEnroll } = await import('./TwoFactorEnroll');

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('TwoFactorEnroll', () => {
  it('sets up, enables with code + current password, then shows the recovery codes once', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onDone = vi.fn();
    act(() => { root.render(<TwoFactorEnroll onDone={onDone} />); });
    try {
      act(() => { (container.querySelector('button') as HTMLButtonElement).click(); });
      await flush();
      expect(container.textContent).toContain('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
      act(() => { setInput(container.querySelector('#tfa-code') as HTMLInputElement, '123456'); });
      act(() => { setInput(container.querySelector('#tfa-password') as HTMLInputElement, 'my-current-pass'); });
      act(() => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
      await flush();
      expect(post).toHaveBeenCalledWith('/2fa/enable', { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', code: '123456', password: 'my-current-pass' });
      const items = [...container.querySelectorAll('[aria-label="Recovery codes"] li')].map((li) => li.textContent);
      expect(items).toEqual(['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh']);
      act(() => { [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('saved'))!.click(); });
      expect(onDone).toHaveBeenCalled();
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });
});
