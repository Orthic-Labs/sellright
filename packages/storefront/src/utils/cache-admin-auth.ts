import type { RequestEventBase } from '@qwik.dev/router';

export const CACHE_ADMIN_TOKEN_HEADER = 'x-cache-admin-token';

export const requireCacheAdminToken = (request: RequestEventBase['request']) => {
	const expectedToken = process.env.CACHE_ADMIN_TOKEN;
	const providedToken = request.headers.get(CACHE_ADMIN_TOKEN_HEADER);

	if (!expectedToken) {
		return { ok: false, status: 503, error: 'CACHE_ADMIN_TOKEN is not configured' };
	}

	if (!providedToken || providedToken !== expectedToken) {
		return { ok: false, status: 403, error: 'Forbidden' };
	}

	return { ok: true, status: 200, error: '' };
};
