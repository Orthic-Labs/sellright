import type { RequestHandler } from '@qwik.dev/router';
import { requireCacheAdminToken, CACHE_ADMIN_TOKEN_HEADER } from '~/utils/cache-admin-auth';

// Thin proxy to the real Cloudflare purge route on the SellRight API
// (packages/api/src/routes/admin-cache.ts). This used to point at
// http://localhost:3100/cache-admin/purge, a backend endpoint that never
// existed on this REST-first stack (see docs/ARCHITECTURE.md) — the /cache
// debug page's "Clear" button 500'd unconditionally. The API does its own
// independent, constant-time token check; requireCacheAdminToken() here is a
// second, storefront-side gate so an unauthenticated caller never even
// reaches the proxy hop.
export const onPost: RequestHandler = async ({ request, json }) => {
	const auth = requireCacheAdminToken(request);
	if (!auth.ok) {
		throw json(auth.status, { success: false, error: auth.error });
	}

	const apiUrl = process.env.VITE_SELLRIGHT_API_URL || 'http://127.0.0.1:3300';
	const storeSlug = process.env.VITE_SELLRIGHT_STORE_SLUG || 'demo';
	const token = process.env.CACHE_ADMIN_TOKEN ?? '';

	// Fetch + parse happen inside the try (network/JSON failures land in the
	// catch below); the success throw json(...) happens OUTSIDE it — json()
	// itself throws to short-circuit the response, and wrapping that throw in
	// its own try/catch here would let this function's catch swallow its own
	// success response and override it with a 500 (the exact bug this route
	// used to have with its dead upstream URL, just one layer further in).
	let status: number;
	let parsed: unknown;
	try {
		const body = await request.json().catch(() => ({}));
		const backendResponse = await fetch(`${apiUrl}/v1/admin/cache/purge`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				[CACHE_ADMIN_TOKEN_HEADER]: token,
			},
			body: JSON.stringify({ storeSlug, ...body }),
		});
		status = backendResponse.status;
		const text = await backendResponse.text();
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { raw: text };
		}
	} catch (error) {
		console.error('[cache-admin/purge] proxy error', error);
		throw json(502, { success: false, error: 'Proxy error reaching the API' });
	}

	throw json(status, parsed);
};
