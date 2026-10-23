import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onGet } from '~/routes/api/country';
import { parseCdnCountry, lookupCountryCode, ipCountryFallbackEnabled, trustsCdnCountryHeader } from './visitor-country';

const jsonResponse = (body: unknown, status = 200) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const callRoute = async (countryHeader?: string) => {
	const headers = new Headers();
	let body: unknown;
	const request = new Request('https://shop.test/api/country/', { headers: countryHeader ? { 'cf-ipcountry': countryHeader } : {} });
	await (onGet as unknown as (ev: unknown) => Promise<void>)({ request, headers: { set: (k: string, v: string) => headers.set(k, v) }, json: (_s: number, b: unknown) => { body = b; } });
	return { headers, body };
};

describe('/api/country — first-party answer from the CDN country header', () => {
	beforeEach(() => vi.stubEnv('BEHIND_CLOUDFLARE', '1'));
	afterEach(() => vi.unstubAllEnvs());

	it('answers the header country and is never cached', async () => {
		const { headers, body } = await callRoute('gb');
		expect(body).toEqual({ country_code: 'GB' });
		expect(headers.get('cache-control')).toContain('no-store');
		expect(headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
	});

	it('answers null when the header is absent, XX (unknown) or T1 (Tor) — still no-store', async () => {
		for (const h of [undefined, 'XX', 'T1', 'USA', '']) {
			const { headers, body } = await callRoute(h);
			expect(body).toEqual({ country_code: null });
			expect(headers.get('cache-control')).toContain('no-store');
		}
	});

	it('parseCdnCountry accepts only a two-letter code', () => {
		expect(parseCdnCountry(' de ')).toBe('DE');
		expect(parseCdnCountry(null)).toBeNull();
		expect(parseCdnCountry('1A')).toBeNull();
	});
});

describe('/api/country — the header is trusted only behind an edge that overwrites it', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('by default (BEHIND_CLOUDFLARE unset) a supplied header is ignored: null, still no-store', async () => {
		vi.stubEnv('BEHIND_CLOUDFLARE', '');
		const { headers, body } = await callRoute('GB');
		expect(body).toEqual({ country_code: null });
		expect(headers.get('cache-control')).toContain('no-store');
	});

	it('only the exact opt-in 1 trusts it', async () => {
		for (const v of ['0', 'true', 'yes']) {
			vi.stubEnv('BEHIND_CLOUDFLARE', v);
			expect((await callRoute('GB')).body).toEqual({ country_code: null });
		}
		vi.stubEnv('BEHIND_CLOUDFLARE', '1');
		expect((await callRoute('GB')).body).toEqual({ country_code: 'GB' });
	});

	it('trustsCdnCountryHeader defaults to false', () => {
		expect(trustsCdnCountryHeader(undefined)).toBe(false);
		expect(trustsCdnCountryHeader(' 1 ')).toBe(true);
	});
});

describe('lookupCountryCode — third party only as the fallback', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('uses the first-party answer and never calls the third party', async () => {
		const fetchMock = vi.fn((_url: string) => jsonResponse({ country_code: 'ca' }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await lookupCountryCode()).toBe('CA');
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/country/']);
	});

	it('falls back to the third party when the header gave no answer', async () => {
		const fetchMock = vi.fn((url: string) => jsonResponse(url === '/api/country/' ? { country_code: null } : { country_code: 'fr' }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await lookupCountryCode()).toBe('FR');
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/country/', 'https://ipapi.co/json/']);
	});

	it('falls back when the first-party call fails, and returns null when both do', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url === '/api/country/') throw new Error('offline'); return new Response('{}', { status: 500 }); }));
		expect(await lookupCountryCode()).toBeNull();
	});

	it('VITE_IP_COUNTRY_FALLBACK=0 never calls the third party', async () => {
		vi.stubEnv('VITE_IP_COUNTRY_FALLBACK', '0');
		const fetchMock = vi.fn((_url: string) => jsonResponse({ country_code: null }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await lookupCountryCode()).toBeNull();
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/country/']);
		vi.unstubAllEnvs();
	});

	it('ipCountryFallbackEnabled: on unless 0/false/off', () => {
		expect(ipCountryFallbackEnabled(undefined)).toBe(true);
		expect(ipCountryFallbackEnabled('1')).toBe(true);
		for (const v of ['0', 'false', 'OFF', ' 0 ']) expect(ipCountryFallbackEnabled(v)).toBe(false);
	});

	it('addressStorage no longer calls the third party directly', () => {
		const src = readFileSync(join(process.cwd(), 'src/utils/addressStorage.ts'), 'utf8');
		expect(src).not.toContain('ipapi.co');
		expect(src).toContain('lookupCountryCodeOnce()');
	});
});
