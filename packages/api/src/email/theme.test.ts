import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_THEME, resolveEmailTheme } from './theme.js';
import { passwordReset, trialLicenseKey, type StoreCtx } from './templates.js';

const base: StoreCtx = { name: 'Brand B', currency: 'USD', storefrontUrl: 'https://b.example', fromEmail: 'orders@b.example' };

describe('resolveEmailTheme', () => {
  it('returns engine defaults for missing or non-object config', () => {
    expect(resolveEmailTheme(undefined)).toBe(DEFAULT_EMAIL_THEME);
    expect(resolveEmailTheme(null)).toBe(DEFAULT_EMAIL_THEME);
    expect(resolveEmailTheme('x')).toBe(DEFAULT_EMAIL_THEME);
    expect(resolveEmailTheme({ emailTheme: [] })).toBe(DEFAULT_EMAIL_THEME);
  });

  it('applies valid overrides per key and keeps defaults for the rest', () => {
    const t = resolveEmailTheme({
      emailTheme: {
        fontFamily: 'Georgia, serif',
        logoUrl: 'https://cdn.example/logo.png',
        footerText: 'Brand B Shop',
        colors: { button: '#ff5630', buttonText: '#FFF', text: 'nope' },
      },
    });
    expect(t.fontFamily).toBe('Georgia, serif');
    expect(t.logoUrl).toBe('https://cdn.example/logo.png');
    expect(t.footerText).toBe('Brand B Shop');
    expect(t.colors.button).toBe('#ff5630');
    expect(t.colors.buttonText).toBe('#FFF');
    expect(t.colors.text).toBe(DEFAULT_EMAIL_THEME.colors.text); // invalid hex ignored
    expect(t.colors.muted).toBe(DEFAULT_EMAIL_THEME.colors.muted);
  });

  it('rejects markup, CSS and non-http URLs (admin config must not inject into mail)', () => {
    const t = resolveEmailTheme({
      emailTheme: {
        fontFamily: 'Arial"><script>x</script>',
        logoUrl: 'javascript:alert(1)',
        footerText: 'line\nbreak',
        colors: { button: 'red;background:url(x)' },
      },
    });
    expect(t.fontFamily).toBe(DEFAULT_EMAIL_THEME.fontFamily);
    expect(t.logoUrl).toBeNull();
    expect(t.footerText).toBeNull();
    expect(t.colors.button).toBe(DEFAULT_EMAIL_THEME.colors.button);
  });

  it('returns frozen objects', () => {
    const t = resolveEmailTheme({ emailTheme: { colors: { button: '#123456' } } });
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(t.colors)).toBe(true);
  });
});

describe('theme tokens reach templates', () => {
  const themed: StoreCtx = {
    ...base,
    theme: resolveEmailTheme({
      emailTheme: {
        logoUrl: 'https://cdn.example/logo.png',
        footerText: 'Brand B Shop',
        colors: { button: '#ff5630', buttonText: '#ffffff', muted: '#555555' },
      },
    }),
  };

  it('uses the store button colour, logo and footer text in html', () => {
    const m = passwordReset(themed, { url: 'https://b.example/reset', ttlHours: 2 });
    expect(m.html).toContain('background:#ff5630;color:#ffffff');
    expect(m.html).not.toContain('background:#222');
    expect(m.html).toContain('<img src="https://cdn.example/logo.png" alt="Brand B"');
    expect(m.html).toContain('<p style="color:#888;font-size:12px">Brand B Shop</p>');
    expect(m.text.endsWith('— Brand B Shop')).toBe(true);
    expect(m.subject).toBe('[Brand B] Reset your password'); // subject keeps store name
  });

  it('applies the muted colour and surface token to the trial key box', () => {
    const m = trialLicenseKey(themed, { key: 'HR-1', days: 14, pricingUrl: 'https://b.example/pricing' });
    expect(m.html).toContain('background:#f6f6f6'); // surface not overridden
    expect(m.html).toContain('background:#ff5630');
  });
});
