// A20: the three platform settings, typed, with the defaults brand-env.schema.json declares (settings section). This module
// only DEFINES and validates them; no stock or payment code reads it yet (wiring `pdp.stockRefreshTrigger`, `shop.stockOnLoad`
// and `pdp.bfcacheRefresh` into the PDP/shop paths is a stock-architecture change and needs the owner's go, plan O1/O3).
// compose emits the validated brand.json settings only as a hash today; until it also emits values, every storefront runs
// the defaults, which are today's behaviour: qidle PDP refresh, manifest-only shop load, no bfcache refresh.
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

export const platformSettings: PlatformSettings = resolvePlatformSettings(undefined);
