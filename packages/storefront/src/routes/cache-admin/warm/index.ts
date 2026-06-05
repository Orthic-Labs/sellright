import type { RequestHandler } from '@qwik.dev/router';

export const onPost: RequestHandler = async ({ json }) => {
        const origin = process.env.STOREFRONT_ORIGIN || 'https://www.damneddesigns.com';

        const pathsToWarm = [
                '/', 
                '/shop/', 
        ];

        // Fetch dynamic product slugs to warm
        try {
                const query = `
                        query GetProductSlugs {
                                products(options: { take: 500 }) {
                                        items {
                                                slug
                                        }
                                }
                        }
                `;
                const response = await fetch(`${origin}/shop-api`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query }),
                });
                const resJson = await response.json();
                const items = resJson?.data?.products?.items || [];
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

	// 2. Trigger remote edge warmers in parallel using direct region subdomains
	const edgeRegions = ['iad', 'dfw', 'lhr', 'sin'];
	const edgePromises = edgeRegions.map(async (region) => {
		try {
			const res = await fetch(`https://damneddesigns-cache-warmer.fly.dev/warm`, {
				headers: {
					'x-warm-token': 'potholes@2',
					'fly-prefer-region': region
				}
			});
			return await res.json();
		} catch (error) {
			return { region, error: error instanceof Error ? error.message : String(error) };
		}
	});

	const edgeResults = await Promise.all(edgePromises);

	throw json(200, { 
		success: true, 
		local: localResults,
		edge: edgeResults
	});
};

