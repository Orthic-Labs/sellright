import { describe, expect, it } from 'vitest';
import { resolveApiUrls, normalizeApiUrl, assertProdApiConfigured, SELLRIGHT_DEV_API_DEFAULT, PROD_API } from './constants';

describe('normalizeApiUrl', () => {
	it('strips trailing slashes and backticks, falls back when empty', () => {
		expect(normalizeApiUrl('https://api.example.com/', 'fallback')).toBe('https://api.example.com');
		expect(normalizeApiUrl('`https://api.example.com`', 'fallback')).toBe('https://api.example.com');
		expect(normalizeApiUrl(undefined, 'fallback')).toBe('fallback');
		expect(normalizeApiUrl('', 'fallback')).toBe('fallback');
	});
});

describe('resolveApiUrls', () => {
	it('uses the SellRight dev-port default when nothing is configured', () => {
		const out = resolveApiUrls({ prodUrl: undefined, devUrl: undefined, localUrl: undefined });
		expect(out).toEqual({ devApi: SELLRIGHT_DEV_API_DEFAULT, prodApi: SELLRIGHT_DEV_API_DEFAULT, localApi: SELLRIGHT_DEV_API_DEFAULT });
		expect(SELLRIGHT_DEV_API_DEFAULT).not.toContain('3100'); // must not be the old Vendure-era port
	});

	it('resolves each tier from its own configured value', () => {
		const out = resolveApiUrls({
			prodUrl: 'https://api.example.com',
			devUrl: 'https://dev.example.com',
			localUrl: 'http://127.0.0.1:3300',
		});
		expect(out).toEqual({ devApi: 'https://dev.example.com', prodApi: 'https://api.example.com', localApi: 'http://127.0.0.1:3300' });
	});

	it('never throws — VITE_* is build-time inlined and this runs during the build itself', () => {
		expect(() => resolveApiUrls({ prodUrl: undefined, devUrl: undefined, localUrl: undefined })).not.toThrow();
	});
});

describe('assertProdApiConfigured', () => {
	it('fails loud when NODE_ENV=production and PROD_API is still the dev-port default', () => {
		// In this test process PROD_API resolved from whatever env this test
		// runner has — assert against the real exported value, matching how
		// entry.express.tsx actually calls this at startup.
		if (PROD_API === SELLRIGHT_DEV_API_DEFAULT) {
			expect(() => assertProdApiConfigured('production')).toThrow(/VITE_SELLRIGHT_PROD_URL is required/);
		} else {
			expect(() => assertProdApiConfigured('production')).not.toThrow();
		}
	});

	it('never throws outside production, regardless of PROD_API', () => {
		expect(() => assertProdApiConfigured('development')).not.toThrow();
		expect(() => assertProdApiConfigured(undefined)).not.toThrow();
	});
});
