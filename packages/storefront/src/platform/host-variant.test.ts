import { describe, expect, it } from 'vitest';
import type { BrandHosts } from '~/platform/brand-data';
import { normalizeHost, resolveHostVariant, variantByKey, variantStyle } from './host-variant';

const DATA: BrandHosts = {
	version: 1,
	stripPrefixes: ['www', 'store', 'buy'],
	default: 'alpha.test',
	hosts: {
		'beta.app': { key: 'beta', name: 'Beta', wordmark: ['Be', 'ta'], domain: 'beta.app', collection: 'beta-col', tokens: { '--accent': '#DF3400', '--bg': '#F7F3EC', '--font-display': 'Tanker' } },
		'alpha.test': { key: 'alpha', name: 'Alpha', domain: 'alpha.test', tokens: {} },
	},
};

describe('host variants', () => {
	it('normalises: lower case, no port, one stripped prefix label', () => {
		expect(normalizeHost('Store.Beta.App:4500', DATA.stripPrefixes)).toBe('beta.app');
		expect(normalizeHost('www.store.beta.app', DATA.stripPrefixes)).toBe('store.beta.app');
		expect(normalizeHost('shop.beta.app', DATA.stripPrefixes)).toBe('shop.beta.app');
		expect(normalizeHost('store', DATA.stripPrefixes)).toBe('store');
		expect(normalizeHost(undefined)).toBe('');
	});

	it('resolves the host, a prefixed host, a bare key, and falls back to the default', () => {
		expect(resolveHostVariant('beta.app', DATA)?.key).toBe('beta');
		expect(resolveHostVariant('buy.beta.app', DATA)?.key).toBe('beta');
		expect(resolveHostVariant('beta', DATA)?.key).toBe('beta');
		expect(resolveHostVariant('unknown.example', DATA)?.key).toBe('alpha');
		expect(resolveHostVariant(null, DATA)?.key).toBe('alpha');
		expect(resolveHostVariant('__proto__', DATA)?.key).toBe('alpha');
		expect(resolveHostVariant('beta.app', null)).toBeNull();
	});

	it('projects a plain variant: the style keeps the declared token order, defaults fill wordmark and collection', () => {
		expect(resolveHostVariant('store.beta.app', DATA)).toEqual({
			key: 'beta', name: 'Beta', wordmark: ['Be', 'ta'], domain: 'beta.app', collection: 'beta-col',
			style: '--accent:#DF3400;--bg:#F7F3EC;--font-display:Tanker;',
		});
		expect(resolveHostVariant('alpha.test', DATA)).toEqual({ key: 'alpha', name: 'Alpha', wordmark: ['Alpha', ''], domain: 'alpha.test', collection: 'alpha', style: '' });
		expect(variantStyle({})).toBe('');
	});

	it('finds a variant by key (a license app), or undefined', () => {
		expect(variantByKey('beta', DATA)?.name).toBe('Beta');
		expect(variantByKey('gamma', DATA)).toBeUndefined();
		expect(variantByKey('beta', null)).toBeUndefined();
	});
});
