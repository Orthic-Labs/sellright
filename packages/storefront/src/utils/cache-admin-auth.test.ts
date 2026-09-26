import { afterEach, describe, expect, it } from 'vitest';
import { requireCacheAdminToken, CACHE_ADMIN_TOKEN_HEADER } from './cache-admin-auth';

function req(headers: Record<string, string> = {}): Request {
	return new Request('http://localhost/cache-admin/purge', { headers });
}

const ORIGINAL = process.env.CACHE_ADMIN_TOKEN;
afterEach(() => {
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
