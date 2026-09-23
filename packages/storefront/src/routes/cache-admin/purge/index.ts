import type { RequestHandler } from '@qwik.dev/router';
import { requireCacheAdminToken } from '~/utils/cache-admin-auth';

export const onPost: RequestHandler = async ({ request, json }) => {
	const auth = requireCacheAdminToken(request);
	if (!auth.ok) {
		throw json(auth.status, { success: false, error: auth.error });
	}

	try {
		const body = await request.text();

		const backendResponse = await fetch('http://localhost:3100/cache-admin/purge', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body,
		});

		const text = await backendResponse.text();
		let parsed: any = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { raw: text };
		}

		throw json(backendResponse.status, parsed);
	} catch (error) {
		console.error('[cache-admin/purge] proxy error', error);
		throw json(500, { success: false, error: 'Proxy error' });
	}
};
