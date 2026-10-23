/**
 * Visitor country: geolocate once, cache the result, and let the shopper's own choice override it (and stay saved).
 * Also guards that the retired legacy-platform cache sync (/api/cache-version poll, /api/cache-events EventSource) is gone.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountryPreferenceService } from '~/services/CountryPreferenceService';
import { clearStoredAddress, getOrResolveCountryCode, loadCountryOnDemand } from '~/utils/addressStorage';
import { resetCountryLookupForTests } from '~/utils/visitor-country';

// Run the QRL bodies directly, outside rendering.
vi.mock('@qwik.dev/core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@qwik.dev/core')>()),
	$: <T,>(fn: T) => fn,
}));

const KEY = 'sr_country_pref';
const appState = () => ({ shippingAddress: { countryCode: '' } });
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null');

let lookups: string[];
function mockLookup(country: string | null) {
	vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
		lookups.push(String(input));
		return country ? new Response(JSON.stringify({ country_code: country }), { status: 200 }) : new Response('{}', { status: 404 });
	}));
}

beforeEach(() => {
	localStorage.clear();
	resetCountryLookupForTests();
	lookups = [];
	vi.stubEnv('VITE_IP_COUNTRY_FALLBACK', '0');
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('(a) geolocate once, then cache — including a US result', () => {
	it('a US geolocation result is recorded as geo and never looked up again', async () => {
		mockLookup('US');
		const state = appState();
		await loadCountryOnDemand(state);
		expect(state.shippingAddress.countryCode).toBe('US');
		expect(stored()).toEqual({ countryCode: 'US', source: 'geo' });
		expect(lookups).toHaveLength(1);

		resetCountryLookupForTests(); // a new page load
		await loadCountryOnDemand(appState());
		await loadCountryOnDemand(appState());
		await getOrResolveCountryCode(appState());
		expect(lookups).toHaveLength(1);
	});

	it('a non-US result is cached and applied', async () => {
		mockLookup('DE');
		const state = appState();
		await getOrResolveCountryCode(state);
		expect(state.shippingAddress.countryCode).toBe('DE');
		expect(CountryPreferenceService.getSource()).toBe('geo');
	});

	it('concurrent purchase-intent calls in one page load share one lookup', async () => {
		mockLookup('FR');
		await Promise.all([loadCountryOnDemand(appState()), loadCountryOnDemand(appState()), getOrResolveCountryCode(appState())]);
		expect(lookups).toHaveLength(1);
	});

	it('a failed lookup is not cached: the default stays, and the next page load tries again', async () => {
		mockLookup(null);
		const state = appState();
		await loadCountryOnDemand(state);
		await loadCountryOnDemand(appState());
		expect(state.shippingAddress.countryCode).toBe('US');
		expect(CountryPreferenceService.needsGeolocation()).toBe(true);
		expect(lookups).toHaveLength(1);
		resetCountryLookupForTests();
		mockLookup('CA');
		await loadCountryOnDemand(appState());
		expect(CountryPreferenceService.getCountry()).toBe('CA');
	});

	it('no lookup when an explicit choice exists', async () => {
		mockLookup('DE');
		CountryPreferenceService.setCountry('US');
		const state = appState();
		await loadCountryOnDemand(state);
		expect(state.shippingAddress.countryCode).toBe('US');
		expect(lookups).toHaveLength(0);
	});

	describe('migrates values stored before the source was recorded', () => {
		const legacy = (value: unknown) => localStorage.setItem(KEY, JSON.stringify(value));
		it('explicit stays explicit', () => {
			legacy({ countryCode: 'US', explicit: true });
			expect(CountryPreferenceService.getSource()).toBe('explicit');
		});
		it('a non-explicit non-US code was a geolocation result', () => {
			legacy({ countryCode: 'DE', explicit: false });
			expect(CountryPreferenceService.getSource()).toBe('geo');
			expect(CountryPreferenceService.getCountry()).toBe('DE');
		});
		it('a non-explicit US is indistinguishable from the placeholder: default, geolocated once more', async () => {
			legacy({ countryCode: 'US', explicit: false });
			expect(CountryPreferenceService.needsGeolocation()).toBe(true);
			mockLookup('US');
			await loadCountryOnDemand(appState());
			expect(stored()).toEqual({ countryCode: 'US', source: 'geo' });
		});
	});
});

describe('(b) a geolocation result never overwrites an explicit choice', () => {
	it('setCountryFromGeolocation is a no-op when explicit', () => {
		CountryPreferenceService.setCountry('GB');
		CountryPreferenceService.setCountryFromGeolocation('DE');
		expect(stored()).toEqual({ countryCode: 'GB', source: 'explicit' });
	});

	it('a choice made while the lookup is in flight wins', async () => {
		let answer!: (r: Response) => void;
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
		const state = appState();
		const pending = loadCountryOnDemand(state);
		await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
		CountryPreferenceService.setCountry('JP');
		answer(new Response(JSON.stringify({ country_code: 'DE' }), { status: 200 }));
		await pending;
		expect(stored()).toEqual({ countryCode: 'JP', source: 'explicit' });
		expect(state.shippingAddress.countryCode).toBe('JP');
	});

	it('an override passed to getOrResolveCountryCode is explicit', async () => {
		mockLookup('DE');
		await getOrResolveCountryCode(appState(), 'au');
		expect(stored()).toEqual({ countryCode: 'AU', source: 'explicit' });
		expect(lookups).toHaveLength(0);
	});

	it('a geolocation result can replace an earlier geolocation result (only explicit is protected)', () => {
		CountryPreferenceService.setCountryFromGeolocation('DE');
		CountryPreferenceService.setCountryFromGeolocation('FR');
		expect(stored()).toEqual({ countryCode: 'FR', source: 'geo' });
	});
});

describe('(c) logout resets to the default state', () => {
	it('clearStoredAddress after an explicit choice: not explicit, not geolocated, US', () => {
		CountryPreferenceService.setCountry('GB');
		clearStoredAddress();
		expect(stored()).toEqual({ countryCode: 'US', source: 'default' });
		expect(CountryPreferenceService.hasExplicitCountrySelection()).toBe(false);
		expect(CountryPreferenceService.needsGeolocation()).toBe(true);
	});

	it('the next visit after logout geolocates once again', async () => {
		CountryPreferenceService.setCountryFromGeolocation('DE');
		clearStoredAddress();
		mockLookup('IT');
		await loadCountryOnDemand(appState());
		expect(stored()).toEqual({ countryCode: 'IT', source: 'geo' });
		expect(lookups).toHaveLength(1);
	});

	// The retired cart blob (its key is the one allowlisted legacy name) is covered in services/legacy-cart.test.ts.
	it('both logout handlers call the reset', () => {
		const src = join(process.cwd(), 'src');
		for (const rel of ['platform/controllers/shell.tsx', 'components/account/AccountNav.tsx']) {
			expect(readFileSync(join(src, rel), 'utf8'), rel).toMatch(/clearStoredAddress\(\);\s*window\.location\.reload\(\)/);
		}
	});
});

describe('retired legacy-platform cache sync', () => {
	const SRC = join(process.cwd(), 'src');
	const files = (dir = SRC, out: string[] = []): string[] => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) files(full, out);
			else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
		}
		return out;
	};

	it('no source requests /api/cache-version or opens /api/cache-events', () => {
		const hits = files().filter((f) => /cache-version|cache-events|EventSource|startCacheSync/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
		expect(hits).toEqual([]);
	});
});
