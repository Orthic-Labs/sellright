import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetAnalyticsForTests, setAnalyticsConsent } from './analytics';
import {
	ATTRIBUTION_MAX_CHARS,
	ATTRIBUTION_STORAGE_KEY,
	attributionFromSearch,
	captureAttribution,
	carryAttributionParams,
	sanitizeAttribution,
	storedAttribution,
} from './attribution';

const LANDING = 'https://rottenhand.com/products/tee/?utm_source=chatgpt&utm_medium=cpc&utm_campaign=rh_us_shirts_202610&utm_content=test&oppref=op_123&fbclid=x';

beforeEach(() => {
	__resetAnalyticsForTests();
	sessionStorage.clear();
});
afterEach(() => __resetAnalyticsForTests());

describe('landing attribution', () => {
	it('reads only the allowlisted keys, trimmed, without control characters, capped', () => {
		expect(attributionFromSearch(new URL(LANDING).searchParams)).toEqual({ utm_source: 'chatgpt', utm_medium: 'cpc', utm_campaign: 'rh_us_shirts_202610', utm_content: 'test', oppref: 'op_123' });
		expect(attributionFromSearch(new URLSearchParams('q=1'))).toBeNull();
		expect(attributionFromSearch(new URLSearchParams('utm_term=%20&utm_source='))).toBeNull();
		expect(sanitizeAttribution({ utm_term: ' a\u0000b\n ', other: 'x' })).toEqual({ utm_term: 'ab' });
		expect(sanitizeAttribution({ oppref: 'x'.repeat(ATTRIBUTION_MAX_CHARS + 50) })?.oppref).toHaveLength(ATTRIBUTION_MAX_CHARS);
	});

	it('stores nothing and returns nothing without analytics consent', () => {
		captureAttribution(LANDING);
		expect(sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
		sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ utm_source: 'x' }));
		expect(storedAttribution()).toBeNull();
	});

	it('last touch: a URL with keys replaces the whole set; a URL without keys keeps it', () => {
		setAnalyticsConsent(true);
		captureAttribution(LANDING);
		captureAttribution('https://rottenhand.com/checkout/');
		captureAttribution('https://rottenhand.com/checkout/confirmation/RH1/');
		expect(storedAttribution()).toMatchObject({ utm_source: 'chatgpt', oppref: 'op_123' });
		captureAttribution('https://rottenhand.com/?utm_source=newsletter');
		expect(storedAttribution()).toEqual({ utm_source: 'newsletter' });
	});

	it('re-sanitizes what is stored and survives garbage', () => {
		setAnalyticsConsent(true);
		sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ utm_source: 'ok', injected: 'x', utm_medium: 5 }));
		expect(storedAttribution()).toEqual({ utm_source: 'ok' });
		sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, '{not json');
		expect(storedAttribution()).toBeNull();
	});

	it('carries the keys onto a rebuilt query without overwriting', () => {
		const to = carryAttributionParams(new URL(LANDING).searchParams, new URLSearchParams({ error: 'x', utm_source: 'kept' }));
		expect(to.toString()).toBe('error=x&utm_source=kept&utm_medium=cpc&utm_campaign=rh_us_shirts_202610&utm_content=test&oppref=op_123');
	});
});
