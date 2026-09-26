import type { RequestEventBase } from '@qwik.dev/router';
import { timingSafeEqual } from 'node:crypto';

export const CACHE_ADMIN_TOKEN_HEADER = 'x-cache-admin-token';

/** Constant-time compare — same rule as the real API route
 * (packages/api/src/routes/admin-cache.ts). Different lengths short-circuit
 * before ever calling timingSafeEqual, which throws on mismatched buffer
 * lengths. */
function tokenMatches(expected: string, provided: string | null): boolean {
	if (!provided) return false;
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(provided, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export const requireCacheAdminToken = (request: RequestEventBase['request']) => {
	const expectedToken = process.env.CACHE_ADMIN_TOKEN;
	const providedToken = request.headers.get(CACHE_ADMIN_TOKEN_HEADER);

	if (!expectedToken) {
		return { ok: false, status: 503, error: 'CACHE_ADMIN_TOKEN is not configured' };
	}

	if (!tokenMatches(expectedToken, providedToken)) {
		return { ok: false, status: 403, error: 'Forbidden' };
	}

	return { ok: true, status: 200, error: '' };
};
