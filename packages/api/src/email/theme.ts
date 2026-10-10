/**
 * Email theme tokens (plan 3.8). Resolved per store from `store.config.emailTheme`
 * (existing jsonb config, no migration) over engine defaults. The defaults are the
 * values the templates hard-coded before tokenisation, so a store with no override
 * renders byte-identical mail (golden: templates.golden.test.ts).
 *
 * Config shape (all keys optional):
 *   emailTheme: {
 *     fontFamily?: string,           // CSS font stack, [A-Za-z0-9 ,'-] only
 *     logoUrl?: string,              // absolute http(s) URL, rendered above the title
 *     footerText?: string,           // footer line; default = store name
 *     colors?: { text?, muted?, footer?, rule?, button?, buttonText?, surface? } // #rgb or #rrggbb
 *   }
 *
 * Invalid values are ignored (per key, falling back to the default) so admin-entered
 * config can never inject markup or CSS into a customer-facing message.
 */

export interface EmailThemeColors {
  text: string;
  muted: string;
  footer: string;
  rule: string;
  button: string;
  buttonText: string;
  surface: string;
}

export interface EmailTheme {
  fontFamily: string;
  colors: EmailThemeColors;
  logoUrl: string | null;
  footerText: string | null;
}

export const DEFAULT_EMAIL_THEME: EmailTheme = Object.freeze({
  fontFamily: '-apple-system,Segoe UI,Roboto,sans-serif',
  colors: Object.freeze({
    text: '#222',
    muted: '#666',
    footer: '#888',
    rule: '#eee',
    button: '#222',
    buttonText: '#fff',
    surface: '#f6f6f6',
  }),
  logoUrl: null,
  footerText: null,
});

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FONT = /^[A-Za-z0-9 ,'-]{1,200}$/;
const MAX_FOOTER = 120;
const MAX_URL = 2048;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function validLogoUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > MAX_URL || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : null;
  } catch {
    return null;
  }
}

/** Resolve the effective theme for a store from its config (`store.config` jsonb). */
export function resolveEmailTheme(config: unknown): EmailTheme {
  const raw = asRecord(asRecord(config)?.emailTheme);
  if (!raw) return DEFAULT_EMAIL_THEME;
  const rawColors = asRecord(raw.colors) ?? {};
  const d = DEFAULT_EMAIL_THEME.colors;
  const color = (key: keyof EmailThemeColors): string => {
    const v = rawColors[key];
    return typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : d[key];
  };
  const font = typeof raw.fontFamily === 'string' && FONT.test(raw.fontFamily.trim()) ? raw.fontFamily.trim() : DEFAULT_EMAIL_THEME.fontFamily;
  const footer = typeof raw.footerText === 'string' ? raw.footerText.trim() : '';
  const footerText = footer && footer.length <= MAX_FOOTER && !/[\r\n]/.test(footer) ? footer : null;
  return Object.freeze({
    fontFamily: font,
    colors: Object.freeze({
      text: color('text'),
      muted: color('muted'),
      footer: color('footer'),
      rule: color('rule'),
      button: color('button'),
      buttonText: color('buttonText'),
      surface: color('surface'),
    }),
    logoUrl: validLogoUrl(raw.logoUrl),
    footerText,
  });
}
