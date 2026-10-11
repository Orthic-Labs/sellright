// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLATFORM_SETTING_DEFAULTS, platformSettings, resolvePlatformSettings } from './settings';

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
});
