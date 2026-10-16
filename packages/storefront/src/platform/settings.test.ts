// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLATFORM_SETTING_DEFAULTS, SETTING_ENV, platformSettings, resolvePlatformSettings, settingsFromEnv } from './settings';

describe('platform settings (A20)', () => {
	it('defaults equal the brand-env.schema.json settings defaults (the declaration is the single source)', () => {
		const schema = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../brand-env.schema.json', import.meta.url)), 'utf8')) as {
			settings: Record<string, { default: unknown }>;
		};
		const fromSchema = Object.fromEntries(Object.entries(schema.settings).map(([k, v]) => [k, v.default]));
		expect(PLATFORM_SETTING_DEFAULTS).toEqual(fromSchema);
	});

	it('the default values are today\'s behaviour', () => {
		expect(PLATFORM_SETTING_DEFAULTS).toEqual({ 'pdp.stockRefreshTrigger': 'qidle', 'shop.stockOnLoad': 'manifest', 'pdp.bfcacheRefresh': false });
		expect(platformSettings).toEqual(PLATFORM_SETTING_DEFAULTS);
	});

	it('applies valid overrides and ignores invalid values and unknown keys', () => {
		expect(resolvePlatformSettings({ 'pdp.stockRefreshTrigger': 'qinit', 'pdp.bfcacheRefresh': true })).toEqual({
			'pdp.stockRefreshTrigger': 'qinit',
			'shop.stockOnLoad': 'manifest',
			'pdp.bfcacheRefresh': true,
		});
		expect(resolvePlatformSettings({ 'pdp.stockRefreshTrigger': 'eventually', 'shop.stockOnLoad': 1, extra: true })).toEqual(PLATFORM_SETTING_DEFAULTS);
		for (const raw of [undefined, null, 'x', 3, []]) expect(resolvePlatformSettings(raw)).toEqual(PLATFORM_SETTING_DEFAULTS);
	});

	it('never mutates the defaults', () => {
		const out = resolvePlatformSettings({ 'pdp.bfcacheRefresh': true });
		out['pdp.bfcacheRefresh'] = false;
		expect(PLATFORM_SETTING_DEFAULTS['pdp.bfcacheRefresh']).toBe(false);
	});

	it('each setting reads the build env name brand-env.schema.json declares for it', () => {
		const schema = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../brand-env.schema.json', import.meta.url)), 'utf8')) as { settings: Record<string, { env: string }> };
		expect(SETTING_ENV).toEqual(Object.fromEntries(Object.entries(schema.settings).map(([k, v]) => [k, v.env])));
	});

	it('settingsFromEnv: compose\'s strings in, typed settings out; anything else is the default', () => {
		expect(settingsFromEnv({ VITE_SR_PDP_STOCK_TRIGGER: 'qinit', VITE_SR_SHOP_STOCK_ON_LOAD: 'live', VITE_SR_PDP_BFCACHE_REFRESH: 'true' })).toEqual({ 'pdp.stockRefreshTrigger': 'qinit', 'shop.stockOnLoad': 'live', 'pdp.bfcacheRefresh': true });
		expect(settingsFromEnv({ VITE_SR_PDP_STOCK_TRIGGER: 'qvisible', VITE_SR_SHOP_STOCK_ON_LOAD: 'LIVE', VITE_SR_PDP_BFCACHE_REFRESH: '1' })).toEqual(PLATFORM_SETTING_DEFAULTS);
		expect(settingsFromEnv({})).toEqual(PLATFORM_SETTING_DEFAULTS);
	});
});
