// A20: the three platform settings, typed, with the defaults brand-env.schema.json declares (settings section). compose validates
// brand.json `settings` and writes each one into .env.production as its build env name (the schema's `env`); this module reads them
// once at build time. An absent or invalid value is the default (today's behaviour: qidle PDP refresh, manifest-only shop load, no
// bfcache refresh). Only platform/stock-triggers.ts reads this module (settings.wiring.test.ts): the settings decide WHEN a live read
// happens, never whether stock is cached (it never is) or what missing stock means (out of stock).
export interface PlatformSettings {
	/** When the PDP starts its one live stock refresh. */
	'pdp.stockRefreshTrigger': 'qinit' | 'qidle';
	/** Shop availability on load: manifest only, or one live uncached fail-closed read. */
	'shop.stockOnLoad': 'manifest' | 'live';
	/** Refresh live stock again on a persisted pageshow. */
	'pdp.bfcacheRefresh': boolean;
}

export const PLATFORM_SETTING_DEFAULTS: Readonly<PlatformSettings> = {
	'pdp.stockRefreshTrigger': 'qidle',
	'shop.stockOnLoad': 'manifest',
	'pdp.bfcacheRefresh': false,
};

const ALLOWED: { [K in keyof PlatformSettings]: readonly PlatformSettings[K][] } = {
	'pdp.stockRefreshTrigger': ['qinit', 'qidle'],
	'shop.stockOnLoad': ['manifest', 'live'],
	'pdp.bfcacheRefresh': [true, false],
};

/** Applies `raw` (an object keyed by setting name) over the defaults; an unknown key or invalid value is ignored (the default stays). */
export function resolvePlatformSettings(raw: unknown): PlatformSettings {
	const out: PlatformSettings = { ...PLATFORM_SETTING_DEFAULTS };
	if (!raw || typeof raw !== 'object') return out;
	const input = raw as Record<string, unknown>;
	for (const key of Object.keys(ALLOWED) as (keyof PlatformSettings)[]) {
		const value = input[key];
		if ((ALLOWED[key] as readonly unknown[]).includes(value)) (out as unknown as Record<string, unknown>)[key] = value;
	}
	return out;
}

/** The build env name of each setting (brand-env.schema.json `env`; settings.test.ts keeps them equal). */
export const SETTING_ENV = {
	'pdp.stockRefreshTrigger': 'VITE_SR_PDP_STOCK_TRIGGER',
	'shop.stockOnLoad': 'VITE_SR_SHOP_STOCK_ON_LOAD',
	'pdp.bfcacheRefresh': 'VITE_SR_PDP_BFCACHE_REFRESH',
} as const satisfies Record<keyof PlatformSettings, string>;

/** Settings from build env strings (`true`/`false` for a boolean); anything else falls back to the default. */
export function settingsFromEnv(env: Partial<Record<(typeof SETTING_ENV)[keyof PlatformSettings], string | undefined>>): PlatformSettings {
	const bool = (v: string | undefined) => (v === 'true' ? true : v === 'false' ? false : undefined);
	return resolvePlatformSettings({
		'pdp.stockRefreshTrigger': env.VITE_SR_PDP_STOCK_TRIGGER,
		'shop.stockOnLoad': env.VITE_SR_SHOP_STOCK_ON_LOAD,
		'pdp.bfcacheRefresh': bool(env.VITE_SR_PDP_BFCACHE_REFRESH),
	});
}

// Each name is read statically so Vite inlines it at build time.
export const platformSettings: PlatformSettings = settingsFromEnv({
	VITE_SR_PDP_STOCK_TRIGGER: import.meta.env.VITE_SR_PDP_STOCK_TRIGGER,
	VITE_SR_SHOP_STOCK_ON_LOAD: import.meta.env.VITE_SR_SHOP_STOCK_ON_LOAD,
	VITE_SR_PDP_BFCACHE_REFRESH: import.meta.env.VITE_SR_PDP_BFCACHE_REFRESH,
});
