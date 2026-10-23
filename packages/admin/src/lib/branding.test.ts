import { describe, expect, it } from 'vitest';
import { authThemeVars, contrast, fontFaceCss } from './branding';

// Issue #333: any store palette must stay WCAG AA readable on the sign-in screens.
const PALETTES = {
  damned: { primary: '#B87333', background: '#F7F2EA', surface: '#FFFDF9', text: '#111110', textMuted: '#6B6B68', border: '#E4E2DC', fontDisplay: null, fontBody: null },
  rotten: { primary: '#B07A84', background: '#F7F2EA', surface: '#FDFAF6', text: '#141210', textMuted: '#9C9590', border: '#E8E0D4', fontDisplay: null, fontBody: null },
  pale: { primary: '#FFE066', background: '#FFFFFF', surface: '#FFFFFF', text: '#777777', textMuted: '#BBBBBB', border: '#EEEEEE', fontDisplay: null, fontBody: null },
};

describe('authThemeVars', () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    it(`${name}: button label, hover, links, muted text and errors reach AA`, () => {
      const v = authThemeVars(p);
      expect(contrast(v['--a-on-primary']!, v['--a-primary']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['--a-on-primary']!, v['--a-primary-hover']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['--a-text']!, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['--a-muted']!, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['--a-link']!, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['--a-danger']!, p.surface)).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('no theme: the neutral default, never the admin chrome accent', () => {
    const v = authThemeVars(null);
    expect(v['--a-primary']).toBe('#2563EB');
    expect(Object.values(v).join(' ')).not.toMatch(/cb3d14|CB3D14/);
  });
  it('fontFaceCss keeps only same-origin .woff2 files', () => {
    const css = fontFaceCss({ storeName: 'x', logoUrl: null, theme: null, fontFaces: [
      { family: 'Fraunces', url: '/fonts/fraunces-500.woff2', weight: '500', style: 'normal' },
      { family: 'Evil', url: 'https://evil.example/x.woff2', weight: '400', style: 'normal' },
      { family: 'x"}body{display:none', url: '/fonts/x.woff2', weight: '400', style: 'normal' },
    ] });
    expect(css).toContain('/fonts/fraunces-500.woff2');
    expect(css).not.toContain('evil');
    expect(css).not.toContain('display:none');
  });
});
