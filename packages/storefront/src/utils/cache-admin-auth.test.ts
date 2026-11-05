import { afterEach, describe, expect, it } from 'vitest';
import { requireCacheAdminToken, CACHE_ADMIN_TOKEN_HEADER, _resetCacheAdminFailuresForTest } from './cache-admin-auth';

function req(headers: Record<string, string> = {}): Request {
	return new Request('http://localhost/cache-admin/purge', { headers });
}

const ORIGINAL = process.env.CACHE_ADMIN_TOKEN;
afterEach(() => {
	_resetCacheAdminFailuresForTest();
	if (ORIGINAL === undefined) delete process.env.CACHE_ADMIN_TOKEN;
	else process.env.CACHE_ADMIN_TOKEN = ORIGINAL;
});

describe('requireCacheAdminToken', () => {
	it('fails closed (503) when CACHE_ADMIN_TOKEN is not configured, even with a token supplied', () => {
		delete process.env.CACHE_ADMIN_TOKEN;
		const result = requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'anything' }));
		expect(result).toEqual({ ok: false, status: 503, error: 'CACHE_ADMIN_TOKEN is not configured' });
	});

	it('rejects a missing token (403)', () => {
		process.env.CACHE_ADMIN_TOKEN = 'right-token';
		const result = requireCacheAdminToken(req());
		expect(result.ok).toBe(false);
		expect(result.status).toBe(403);
	});

	it('rejects a wrong token of the same length (403, no crash)', () => {
		process.env.CACHE_ADMIN_TOKEN = 'right-token';
		const result = requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'wrong-token' }));
		expect(result.status).toBe(403);
	});

	it('rejects a wrong token of a different length (403, no crash — the historical failure mode for a naive timingSafeEqual)', () => {
		process.env.CACHE_ADMIN_TOKEN = 'right-token';
		const result = requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'x' }));
		expect(result.status).toBe(403);
	});

	it('accepts the correct token', () => {
		process.env.CACHE_ADMIN_TOKEN = 'right-token';
		const result = requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'right-token' }));
		expect(result).toEqual({ ok: true, status: 200, error: '' });
	});
});

describe('requireCacheAdminToken failure limiter (audit 2026-11-02)', () => {
	it('refuses an IP after 10 wrong guesses, even when it then sends the right token', () => {
		process.env.CACHE_ADMIN_TOKEN = 'right-token';
		for (let i = 0; i < 10; i++) expect(requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: `wrong-${i}` }), '203.0.113.9').status).toBe(403);
		expect(requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'right-token' }), '203.0.113.9').status).toBe(429);
	});

	it('is per IP: another address is unaffected', () => {
		process.env.CACHE_ADMIN_TOKEN = 'right-token';
		for (let i = 0; i < 10; i++) requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'nope' }), '203.0.113.9');
		expect(requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'right-token' }), '203.0.113.10').ok).toBe(true);
	});

	it('forgets failures after the window', () => {
		process.env.CACHE_ADMIN_TOKEN = 'right-token';
		const t0 = 1_000_000;
		for (let i = 0; i < 10; i++) requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'nope' }), '203.0.113.9', t0);
		expect(requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'right-token' }), '203.0.113.9', t0 + 1000).status).toBe(429);
		expect(requireCacheAdminToken(req({ [CACHE_ADMIN_TOKEN_HEADER]: 'right-token' }), '203.0.113.9', t0 + 16 * 60 * 1000).ok).toBe(true);
	});
});
