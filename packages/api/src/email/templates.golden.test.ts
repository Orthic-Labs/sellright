/**
 * Golden regression (plan 3.8): a store with no emailTheme override must render
 * byte-identical mail to the pre-tokenisation engine. The fixture was captured
 * from the untouched templates before the theme refactor.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderConfirmation, passwordReset, type StoreCtx } from './templates.js';
import { resolveEmailTheme } from './theme.js';

const golden = JSON.parse(readFileSync(new URL('./golden/default-theme.golden.json', import.meta.url), 'utf8')) as {
  orderConfirmation: { subject: string; html: string; text: string };
  passwordReset: { subject: string; html: string; text: string };
};

const store: StoreCtx = { name: 'Brand <B> & Co', currency: 'USD', storefrontUrl: 'https://b.example', fromEmail: 'orders@b.example' };

describe('default-theme golden output', () => {
  it('orderConfirmation is byte-identical to the pre-change render', () => {
    const m = orderConfirmation(store, {
      code: 'SR-1', grandTotal: 4200, currency: 'USD',
      lines: [{ name: 'Blade "A"', quantity: 2, lineTotal: 3000 }, { name: 'Sheath', quantity: 1, lineTotal: 1200 }],
    });
    expect(m).toEqual(golden.orderConfirmation);
  });

  it('passwordReset is byte-identical to the pre-change render', () => {
    const m = passwordReset(store, { url: 'https://b.example/reset?token=abc&x=1', ttlHours: 2 });
    expect(m).toEqual(golden.passwordReset);
  });

  it('a store with no emailTheme config resolves to the same output as no theme at all', () => {
    const withConfig = { ...store, theme: resolveEmailTheme({ storefrontUrl: 'https://b.example' }) };
    const data = { url: 'https://b.example/reset', ttlHours: 1 };
    expect(passwordReset(withConfig, data)).toEqual(passwordReset(store, data));
  });
});
