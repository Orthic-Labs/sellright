// #425: dns-prefetch hints per brand config.
import { describe, expect, it } from 'vitest';
import { dnsPrefetchOrigins, gatewaysFromShopConfig, parseGatewaysHeader } from './dns-prefetch';

// The live shapes of GET /v1/shop/config `gateways` (checked 2026-11-01): Damned NMI + Sezzle, Rotten Stripe.
const damnedConfig = { gateways: { nmi: { tokenizationKey: 'k', mode: 'live', environment: 'production' }, sezzle: true }, stripeConfigured: false };
const rottenConfig = { gateways: { nmi: null, sezzle: false }, stripeConfigured: true };
const SEZZLE = ['https://gateway.sezzle.com', 'https://sandbox.gateway.sezzle.com'];

describe('dns-prefetch per brand', () => {
	it('Damned (NMI + Sezzle): NMI and Sezzle hosts, the geo-IP fallback host, no SheerID', () => {
		const origins = dnsPrefetchOrigins({ gateways: gatewaysFromShopConfig(damnedConfig), sheerIdEnabled: false, ipCountryFallback: undefined });
		expect(origins).toEqual(['https://secure.nmi.com', ...SEZZLE, 'https://ipapi.co']);
	});
	it('Rotten (Stripe): none of NMI, Sezzle or SheerID', () => {
		const origins = dnsPrefetchOrigins({ gateways: gatewaysFromShopConfig(rottenConfig), sheerIdEnabled: false, ipCountryFallback: undefined });
		expect(origins).toEqual(['https://ipapi.co']);
		for (const host of ['nmi.com', 'sezzle.com', 'sheerid.com']) expect(origins.join(' ')).not.toContain(host);
	});
	it('SheerID only when the theme enables it; geo-IP only while the browser country fallback is on; never the unused geo hosts', () => {
		expect(dnsPrefetchOrigins({ gateways: [], sheerIdEnabled: true, ipCountryFallback: 'off' })).toEqual(['https://services.sheerid.com']);
		expect(dnsPrefetchOrigins({ gateways: [], sheerIdEnabled: false, ipCountryFallback: '0' })).toEqual([]);
		expect(dnsPrefetchOrigins({ gateways: ['nmi', 'sezzle', 'stripe'], sheerIdEnabled: true, ipCountryFallback: '' }).join(' ')).not.toMatch(/country\.is|geojs/);
	});
	it('the header is parsed to known ids only (a forged value adds nothing)', () => {
		expect(parseGatewaysHeader('nmi,sezzle')).toEqual(['nmi', 'sezzle']);
		expect(parseGatewaysHeader('evil.example, NMI ')).toEqual(['nmi']);
		expect(parseGatewaysHeader(undefined)).toEqual([]);
		expect(gatewaysFromShopConfig(null)).toEqual([]);
	});
});
