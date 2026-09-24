/**
 * Central store theme/brand config. Every brand-specific string (name, domain,
 * support email, social links, colors, fonts, legal entity, address) flows
 * through this module so the storefront package stays a neutral, reusable
 * base — never edit brand copy inline in a component/route, add or override
 * an env var here instead.
 *
 * Colors/fonts are also mirrored as CSS custom properties in `global.css`
 * under `:root` — this module is the single source of truth for the
 * *values*; the CSS file just needs to agree on the variable names.
 *
 * Neutral demo defaults below are placeholders, not a real business — do not
 * present them as a real store's identity.
 */

const env = (key: string, fallback: string): string => {
	const v = (import.meta.env as Record<string, string | undefined>)[key];
	return v && v.trim() ? v.trim() : fallback;
};

const envOrUndefined = (key: string): string | undefined => {
	const v = (import.meta.env as Record<string, string | undefined>)[key];
	return v && v.trim() ? v.trim() : undefined;
};

export interface StoreAddress {
	streetAddress: string;
	addressLocality: string;
	addressRegion: string;
	postalCode: string;
	addressCountry: string;
}

export interface StoreTheme {
	/** Display name shown in header, footer, page titles, JSON-LD. */
	storeName: string;
	/** Full legal entity name for terms/privacy/returns copy. Defaults to storeName. */
	legalName: string;
	/** One-line tagline used in meta description defaults and hero fallback copy. */
	tagline: string;
	/** Public domain, no protocol, no trailing slash (e.g. "example.com"). */
	domain: string;
	/** Public support/contact email. */
	supportEmail: string;
	/** Wordmark text shown when no logo image is configured. */
	logoText: string;
	/** Absolute or root-relative path to a logo image; null renders text logo. */
	logoImageUrl: string | null;
	/** Absolute or root-relative path to an og:image / JSON-LD image. */
	ogImageUrl: string;
	/** Postal address for Organization JSON-LD and legal pages; null omits it. */
	address: StoreAddress | null;
	/** Social profile URLs; omitted entries are left out of sameAs / footer. */
	social: {
		instagram?: string;
		facebook?: string;
		twitter?: string;
		tiktok?: string;
		youtube?: string;
	};
	colors: {
		primary: string;
		secondary: string;
		accent: string;
		background: string;
		surface: string;
		text: string;
		textMuted: string;
		border: string;
	};
	fonts: {
		display: string;
		body: string;
		mono: string;
	};
	currency: string;
	locale: string;
	/** Generic shop-page category filter labels (matched against product tags). */
	shopCategories: string[];
	/**
	 * Short trust-signal phrases shown in the header/PDP/cart/checkout trust
	 * bars. Keep these truthful for whatever this deployment actually does —
	 * checkout only zeroes shipping via an applied free-shipping coupon (see
	 * `ValidateLocalCartCouponQuery.freeShipping`), there is no order-total
	 * threshold, so never phrase this as "free shipping over $X" unless a
	 * real threshold promotion is wired up server-side. Defaults reflect the
	 * generic base product (flat-rate shipping, no payment method claims).
	 */
	policies: {
		shipping: { label: string; sub: string };
		returns: { label: string; sub: string };
		payment: { label: string; sub: string };
	};
	/** Show the SheerID (military/first-responder/teacher/student) verification
	 * banner on the homepage. SheerID is a paid, per-merchant-configured
	 * third-party service — a fresh install (and the isolated demo) has no
	 * account behind it, so this defaults OFF. Set VITE_SHEERID_ENABLED=1 only
	 * once the store's SheerID program is actually configured. */
	sheerIdEnabled: boolean;
	/** True only for the isolated interactive demo build (VITE_DEMO_MODE=1) —
	 * used strictly for copy that must disclose "this is simulated", never for
	 * feature gating (that's what the flags above are for). */
	isDemo: boolean;
}

export const theme: StoreTheme = {
	storeName: env('VITE_STORE_NAME', 'Storefront Demo'),
	legalName: env('VITE_STORE_LEGAL_NAME', env('VITE_STORE_NAME', 'Storefront Demo')),
	tagline: env('VITE_STORE_TAGLINE', 'Quality products, delivered.'),
	domain: env('VITE_PUBLIC_DOMAIN', 'localhost:4100'),
	supportEmail: env('VITE_STORE_SUPPORT_EMAIL', 'support@example.com'),
	logoText: env('VITE_STORE_LOGO_TEXT', env('VITE_STORE_NAME', 'Storefront Demo')),
	logoImageUrl: envOrUndefined('VITE_STORE_LOGO_URL') ?? null,
	ogImageUrl: env('VITE_STORE_OG_IMAGE', '/og-image.jpg'),
	address: envOrUndefined('VITE_STORE_ADDRESS_STREET')
		? {
				streetAddress: env('VITE_STORE_ADDRESS_STREET', ''),
				addressLocality: env('VITE_STORE_ADDRESS_CITY', ''),
				addressRegion: env('VITE_STORE_ADDRESS_REGION', ''),
				postalCode: env('VITE_STORE_ADDRESS_POSTAL', ''),
				addressCountry: env('VITE_STORE_ADDRESS_COUNTRY', 'US'),
			}
		: null,
	social: {
		instagram: envOrUndefined('VITE_STORE_SOCIAL_INSTAGRAM'),
		facebook: envOrUndefined('VITE_STORE_SOCIAL_FACEBOOK'),
		twitter: envOrUndefined('VITE_STORE_SOCIAL_TWITTER'),
		tiktok: envOrUndefined('VITE_STORE_SOCIAL_TIKTOK'),
		youtube: envOrUndefined('VITE_STORE_SOCIAL_YOUTUBE'),
	},
	colors: {
		primary: env('VITE_THEME_COLOR_PRIMARY', '#18181b'),
		secondary: env('VITE_THEME_COLOR_SECONDARY', '#3f3f46'),
		accent: env('VITE_THEME_COLOR_ACCENT', '#2563eb'),
		background: env('VITE_THEME_COLOR_BACKGROUND', '#ffffff'),
		surface: env('VITE_THEME_COLOR_SURFACE', '#f4f4f5'),
		text: env('VITE_THEME_COLOR_TEXT', '#18181b'),
		textMuted: env('VITE_THEME_COLOR_TEXT_MUTED', '#71717a'),
		border: env('VITE_THEME_COLOR_BORDER', '#e4e4e7'),
	},
	fonts: {
		display: env('VITE_THEME_FONT_DISPLAY', 'Inter, system-ui, sans-serif'),
		body: env('VITE_THEME_FONT_BODY', 'Inter, system-ui, sans-serif'),
		mono: env('VITE_THEME_FONT_MONO', 'ui-monospace, SFMono-Regular, monospace'),
	},
	currency: env('VITE_STORE_CURRENCY', 'USD'),
	locale: env('VITE_STORE_LOCALE', 'en'),
	shopCategories: (() => {
		const raw = envOrUndefined('VITE_SHOP_CATEGORIES');
		return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : ['New', 'Bestsellers', 'Sale'];
	})(),
	policies: {
		shipping: { label: env('VITE_POLICY_SHIPPING_LABEL', 'Flat-Rate'), sub: env('VITE_POLICY_SHIPPING_SUB', 'Shipping') },
		returns: { label: env('VITE_POLICY_RETURNS_LABEL', '1 Week'), sub: env('VITE_POLICY_RETURNS_SUB', 'Defect Returns') },
		payment: { label: env('VITE_POLICY_PAYMENT_LABEL', 'Secure'), sub: env('VITE_POLICY_PAYMENT_SUB', 'Checkout') },
	},
	sheerIdEnabled: env('VITE_SHEERID_ENABLED', '') === '1',
	isDemo: env('VITE_DEMO_MODE', '') === '1',
};

/** `"<label> <sub>"` lower-cased for sentence-style trust bars (ticker, cart
 * strip, checkout CTA line) — same source of truth as the two-line stat
 * widgets (hero meta, PDP trust bar), just formatted differently. */
export const policySentence = (p: { label: string; sub: string }): string => `${p.label} ${p.sub}`;

/** `https://` + theme.domain, no trailing slash — the canonical site origin. */
export const siteUrl = `https://${theme.domain}`;

/** Non-empty social URLs, for JSON-LD `sameAs` / footer social icons. */
export const socialLinks: string[] = Object.values(theme.social).filter(
	(v): v is string => typeof v === 'string' && v.length > 0,
);
