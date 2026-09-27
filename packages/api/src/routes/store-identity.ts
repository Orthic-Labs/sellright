/**
 * WS-C: per-store brand identity/theme, served at runtime so one generic
 * storefront image can serve any store (plan §1.9). Lives under
 * store.config.identity (JSONB — same pattern as payments/hostnames). Every
 * field has a neutral fallback so a store that has never set identity still
 * gets a usable response — mirrors packages/storefront/src/theme/theme.config.ts's
 * VITE_* defaults, which remain the storefront's dev/offline fallback.
 */
import { z } from '@hono/zod-openapi';

const StoreAddressSchema = z.object({
  streetAddress: z.string(),
  addressLocality: z.string(),
  addressRegion: z.string(),
  postalCode: z.string(),
  addressCountry: z.string(),
});

export const StoreIdentitySchema = z.object({
  storeName: z.string(),
  legalName: z.string(),
  tagline: z.string(),
  supportEmail: z.string(),
  logoText: z.string(),
  logoImageUrl: z.string().nullable(),
  ogImageUrl: z.string(),
  address: StoreAddressSchema.nullable(),
  social: z.object({
    instagram: z.string().optional(),
    facebook: z.string().optional(),
    twitter: z.string().optional(),
    tiktok: z.string().optional(),
    youtube: z.string().optional(),
  }),
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    textMuted: z.string(),
    border: z.string(),
  }),
  fonts: z.object({
    display: z.string(),
    body: z.string(),
    mono: z.string(),
  }),
  currency: z.string(),
  locale: z.string(),
  /** Full origin, e.g. "https://example.com" — canonical/sitemap/JSON-LD base. */
  siteOrigin: z.string(),
  /** Whether the storefront is publicly visible (plan §1.5: Publish store). */
  published: z.boolean(),
});

export type StoreIdentity = z.infer<typeof StoreIdentitySchema>;

const NEUTRAL_DEFAULTS = {
  storeName: 'Storefront Demo',
  tagline: 'Quality products, delivered.',
  supportEmail: 'support@example.com',
  ogImageUrl: '/og-image.jpg',
  colors: {
    primary: '#18181b',
    secondary: '#3f3f46',
    accent: '#2563eb',
    background: '#ffffff',
    surface: '#f4f4f5',
    text: '#18181b',
    textMuted: '#71717a',
    border: '#e4e4e7',
  },
  fonts: {
    display: 'Inter, system-ui, sans-serif',
    body: 'Inter, system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, monospace',
  },
  locale: 'en',
} as const;

interface StoreRowForIdentity {
  name: string;
  currency: string;
  config: unknown;
}

/** Pure — no I/O. Builds the public identity payload from the store row +
 *  config.identity, falling back to neutral defaults for anything unset. The
 *  store's own `name`/`currency` columns (not config) are the source of truth
 *  for storeName/currency unless config.identity overrides them explicitly. */
export function storeIdentityFromConfig(store: StoreRowForIdentity, published: boolean): StoreIdentity {
  const cfg = (store.config ?? {}) as Record<string, unknown>;
  const identity = (cfg.identity ?? {}) as Record<string, unknown>;
  const str = (key: string, fallback: string): string => {
    const v = identity[key];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
  };
  const strOrUndefined = (key: string): string | undefined => {
    const v = identity[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const storeName = str('storeName', store.name || NEUTRAL_DEFAULTS.storeName);
  const social = (identity.social ?? {}) as Record<string, unknown>;
  const colorsIn = (identity.colors ?? {}) as Record<string, unknown>;
  const fontsIn = (identity.fonts ?? {}) as Record<string, unknown>;
  const addressIn = identity.address as Record<string, unknown> | undefined;
  const siteOrigin = strOrUndefined('siteOrigin') ?? `https://${strOrUndefined('domain') ?? 'localhost'}`;
  return {
    storeName,
    legalName: str('legalName', storeName),
    tagline: str('tagline', NEUTRAL_DEFAULTS.tagline),
    supportEmail: str('supportEmail', NEUTRAL_DEFAULTS.supportEmail),
    logoText: str('logoText', storeName),
    logoImageUrl: strOrUndefined('logoImageUrl') ?? null,
    ogImageUrl: str('ogImageUrl', NEUTRAL_DEFAULTS.ogImageUrl),
    address: addressIn
      ? {
          streetAddress: String(addressIn.streetAddress ?? ''),
          addressLocality: String(addressIn.addressLocality ?? ''),
          addressRegion: String(addressIn.addressRegion ?? ''),
          postalCode: String(addressIn.postalCode ?? ''),
          addressCountry: String(addressIn.addressCountry ?? 'US'),
        }
      : null,
    social: {
      instagram: typeof social.instagram === 'string' ? social.instagram : undefined,
      facebook: typeof social.facebook === 'string' ? social.facebook : undefined,
      twitter: typeof social.twitter === 'string' ? social.twitter : undefined,
      tiktok: typeof social.tiktok === 'string' ? social.tiktok : undefined,
      youtube: typeof social.youtube === 'string' ? social.youtube : undefined,
    },
    colors: {
      primary: typeof colorsIn.primary === 'string' ? colorsIn.primary : NEUTRAL_DEFAULTS.colors.primary,
      secondary: typeof colorsIn.secondary === 'string' ? colorsIn.secondary : NEUTRAL_DEFAULTS.colors.secondary,
      accent: typeof colorsIn.accent === 'string' ? colorsIn.accent : NEUTRAL_DEFAULTS.colors.accent,
      background: typeof colorsIn.background === 'string' ? colorsIn.background : NEUTRAL_DEFAULTS.colors.background,
      surface: typeof colorsIn.surface === 'string' ? colorsIn.surface : NEUTRAL_DEFAULTS.colors.surface,
      text: typeof colorsIn.text === 'string' ? colorsIn.text : NEUTRAL_DEFAULTS.colors.text,
      textMuted: typeof colorsIn.textMuted === 'string' ? colorsIn.textMuted : NEUTRAL_DEFAULTS.colors.textMuted,
      border: typeof colorsIn.border === 'string' ? colorsIn.border : NEUTRAL_DEFAULTS.colors.border,
    },
    fonts: {
      display: typeof fontsIn.display === 'string' ? fontsIn.display : NEUTRAL_DEFAULTS.fonts.display,
      body: typeof fontsIn.body === 'string' ? fontsIn.body : NEUTRAL_DEFAULTS.fonts.body,
      mono: typeof fontsIn.mono === 'string' ? fontsIn.mono : NEUTRAL_DEFAULTS.fonts.mono,
    },
    currency: store.currency || 'USD',
    locale: str('locale', NEUTRAL_DEFAULTS.locale),
    siteOrigin,
    published,
  };
}
