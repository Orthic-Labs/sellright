import type { RequestHandler } from '@qwik.dev/router';
import { requireCacheAdminToken } from '~/utils/cache-admin-auth';

export const onPost: RequestHandler = async ({ request, json }) => {
	const auth = requireCacheAdminToken(request);
	if (!auth.ok) {
		throw json(auth.status, { success: false, error: auth.error });
	}

	const warmToken = process.env.CACHE_WARM_TOKEN;
	if (!warmToken) {
		throw json(503, { success: false, error: 'CACHE_WARM_TOKEN is not configured' });
	}

        const origin = process.env.STOREFRONT_ORIGIN || 'http://localhost:4100';
        const apiUrl = process.env.VITE_SELLRIGHT_API_URL || 'http://127.0.0.1:3300';
        const storeSlug = process.env.VITE_SELLRIGHT_STORE_SLUG || 'demo';

        const pathsToWarm = [
                '/',
                '/shop/',
        ];

        // Fetch dynamic product slugs to warm — SellRight REST catalog (generic,
        // works for any store via x-store-slug; no Vendure /shop-api in this stack).
        try {
                const response = await fetch(`${apiUrl}/v1/shop/catalog/products?limit=500`, {
                        headers: { 'x-store-slug': storeSlug, accept: 'application/json' },
                });
                const resJson = await response.json();
                const items = resJson?.items || [];
                items.forEach((item: { slug: string }) => {
                        pathsToWarm.push(`/products/${item.slug}/`);
                });
        } catch (error) {
                console.error('Failed to fetch product slugs for local warming:', error);
        }

        const localResults = [];

	// 1. Warm locally (origin)
	for (const path of pathsToWarm) {
		try {
			const response = await fetch(`${origin}${path}`);
			localResults.push({
				path,
				status: response.status,
				cfCacheStatus: response.headers.get('cf-cache-status'),
			});
		} catch (error) {
			localResults.push({
				path,
				status: 0,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// 2. Trigger remote edge warmers (optional) — only runs when a store has its
	// own edge-warmer service deployed; CACHE_WARM_EDGE_URL is unset by default.
	const edgeWarmerUrl = process.env.CACHE_WARM_EDGE_URL;
	const edgeRegions = ['iad', 'dfw', 'lhr', 'sin'];
	const edgeResults = edgeWarmerUrl
		? await Promise.all(edgeRegions.map(async (region) => {
			try {
				const res = await fetch(`${edgeWarmerUrl}/warm`, {
					headers: {
						'x-warm-token': warmToken,
						'fly-prefer-region': region
					}
				});
				return await res.json();
			} catch (error) {
				return { region, error: error instanceof Error ? error.message : String(error) };
			}
		}))
		: [];

	throw json(200, { 
		success: true, 
		local: localResults,
		edge: edgeResults
	});
};
