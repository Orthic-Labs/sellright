/**
 * Store branding for the sign-in journey (issue #333): GET /v1/admin/branding answers the store's name, logo and theme
 * tokens (validated server-side). This module turns them into the --a-* custom properties auth.css reads, enforcing
 * WCAG AA text contrast for every derived pair (button label, links, muted text) so any store palette stays readable.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

export interface BrandingTheme { primary: string; background: string; surface: string; text: string; textMuted: string; border: string; fontDisplay: string | null; fontBody: string | null }
export interface Branding { storeName: string | null; logoUrl: string | null; theme: BrandingTheme | null; fontFaces: { family: string; url: string; weight: string; style: 'normal' | 'italic' }[] }

export const NEUTRAL_BRANDING: Branding = { storeName: null, logoUrl: null, theme: null, fontFaces: [] };

/** Neutral default (no store theme): a calm blue action colour on white — never the admin chrome's accent. */
const DEFAULT_THEME: BrandingTheme = {
  primary: '#2563EB', background: '#F4F4F5', surface: '#FFFFFF', text: '#18181B', textMuted: '#52525B', border: '#E4E4E7', fontDisplay: null, fontBody: null,
};
const SYSTEM_SANS = "'Hanken Grotesk', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

type RGB = [number, number, number];
const HEX = /^#([0-9a-f]{6})$/i;
function rgb(hex: string): RGB | null {
  const m = HEX.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = ([r, g, b]: RGB) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function luminance(c: RGB): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
export function contrast(a: string, b: string): number {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return 1;
  const l1 = luminance(x), l2 = luminance(y);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** Mix `a` toward `b` by t (0..1). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return a;
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}
/** Move `color` toward `toward` in steps until it reaches `min` contrast against `bg` (or gets there). */
function ensureContrast(color: string, bg: string, toward: string, min = 4.5): string {
  let c = color;
  for (let i = 1; i <= 20 && contrast(c, bg) < min; i++) c = mix(color, toward, i / 20);
  return c;
}

/** The --a-* custom properties for a theme (or the neutral default). */
export function authThemeVars(theme: BrandingTheme | null): Record<string, string> {
  const t = theme ?? DEFAULT_THEME;
  const text = contrast(t.text, t.surface) >= 4.5 ? t.text : '#111111';
  const ink = contrast('#111111', t.primary) >= contrast('#FFFFFF', t.primary) ? '#111111' : '#FFFFFF';
  // Label on the primary button: white or the store ink, whichever reads (AA); a primary too mid-tone for either is
  // darkened until white passes.
  let primary = t.primary;
  let onPrimary = contrast('#FFFFFF', primary) >= 4.5 ? '#FFFFFF' : contrast(text, primary) >= 4.5 ? text : ink;
  if (contrast(onPrimary, primary) < 4.5) { primary = ensureContrast(primary, '#FFFFFF', '#000000'); onPrimary = '#FFFFFF'; }
  // Hover moves AWAY from the label colour, so the label keeps (or gains) contrast.
  const hover = onPrimary === '#FFFFFF' ? mix(primary, '#000000', 0.12) : mix(primary, '#FFFFFF', 0.12);
  return {
    '--a-bg': t.background,
    '--a-surface': t.surface,
    '--a-text': text,
    '--a-muted': ensureContrast(t.textMuted, t.surface, text),
    '--a-border': t.border,
    '--a-border-strong': ensureContrast(mix(t.border, text, 0.25), t.surface, text, 3),
    '--a-soft': mix(t.surface, t.background === t.surface ? t.border : t.background, 0.55),
    '--a-primary': primary,
    '--a-primary-hover': hover,
    '--a-on-primary': onPrimary,
    // Links in running text: the brand colour when it reads on the card, else the ink.
    '--a-link': contrast(primary, t.surface) >= 4.5 ? primary : text,
    '--a-focus': `color-mix(in srgb, ${text} 22%, transparent)`,
    '--a-danger': ensureContrast('#B42318', t.surface, '#000000'),
    '--a-danger-soft': mix(t.surface, '#B42318', 0.07),
    '--a-danger-ring': mix(t.surface, '#B42318', 0.35),
    '--a-success': ensureContrast('#067647', t.surface, '#000000'),
    '--a-success-soft': mix(t.surface, '#067647', 0.07),
    '--a-success-ring': mix(t.surface, '#067647', 0.3),
    '--a-disabled-bg': mix(t.surface, text, 0.1),
    '--a-disabled-text': ensureContrast(mix(t.surface, text, 0.45), mix(t.surface, text, 0.1), text, 3),
    '--a-font-display': t.fontDisplay ?? t.fontBody ?? SYSTEM_SANS,
    '--a-font-body': t.fontBody ?? SYSTEM_SANS,
    '--a-font-mono': MONO,
    '--a-radius': '14px',
    '--a-radius-sm': '8px',
  };
}

/** @font-face rules for the store's own same-origin font files (validated by the API, re-checked here). */
export function fontFaceCss(b: Branding): string {
  return b.fontFaces
    .filter((f) => /^\/[A-Za-z0-9/._-]+\.woff2$/.test(f.url) && /^[A-Za-z0-9 ,'"-]+$/.test(f.family))
    .map((f) => `@font-face{font-family:"${f.family.replace(/["']/g, '')}";src:url("${f.url}") format("woff2");font-weight:${/^\d{3}( \d{3})?$/.test(f.weight) ? f.weight : '400'};font-style:${f.style === 'italic' ? 'italic' : 'normal'};font-display:swap;}`)
    .join('');
}

let cached: Promise<Branding> | null = null;
/** One fetch per page load; any failure is the neutral default (the screens never block on branding). */
export function loadBranding(): Promise<Branding> {
  cached ??= api.get<Branding>('/branding').then((b) => ({ ...NEUTRAL_BRANDING, ...b, fontFaces: Array.isArray(b?.fontFaces) ? b.fontFaces : [] })).catch(() => NEUTRAL_BRANDING);
  return cached;
}
export function _resetBrandingForTest(): void { cached = null; }

export function useBranding(): { branding: Branding; ready: boolean } {
  const [state, setState] = useState<{ branding: Branding; ready: boolean }>({ branding: NEUTRAL_BRANDING, ready: false });
  useEffect(() => {
    let live = true;
    void loadBranding().then((branding) => { if (live) setState({ branding, ready: true }); });
    return () => { live = false; };
  }, []);
  return state;
}
