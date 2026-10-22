// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_METADATA_TITLE } from '~/constants';
import { createSEOHead } from '~/utils/seo';
import { canonicalHref, contentHead, resolveHead, serialiseJsonLd, setMeta, type BrandHeadSpec, type HeadSources } from './head-resolve';
import { analyticsCsp, GTM_LOADER_SOURCE } from './head-analytics';
import { buildCsp } from '~/utils/csp';

const identity = { storeName: 'Store', siteOrigin: 'https://store.example', ogImageUrl: '/og.png', tagline: 'Tag line', locale: 'en-US' } as never;
type Head = Parameters<typeof resolveHead>[0];

const routeHead = (over: Parameters<typeof createSEOHead>[0]): Head => {
	const h = createSEOHead({ identity, ...over });
	return { title: (h as { title: string }).title, meta: (h as { meta: unknown[] }).meta, links: (h as { links?: unknown[] }).links ?? [], styles: [], scripts: [], frontmatter: {} } as unknown as Head;
};
const sources = (spec: BrandHeadSpec = {}, decl: Record<string, { title?: string; description?: string; noindex?: boolean }> = {}): HeadSources => ({ spec, declaration: (p) => decl[p.endsWith('/') ? p : `${p}/`] ?? null });
const meta = (h: Head, key: string) => (h.meta as { name?: string; property?: string; content?: string }[]).filter((m) => m.name === key || m.property === key);

describe('resolveHead: no brand data means today\'s head', () => {
	it('returns the route head object itself (same reference) with every extra empty', () => {
		const head = routeHead({ title: 'Shop', description: 'D', canonical: 'https://store.example/shop/' });
		const r = resolveHead(head, '/shop/', identity, sources());
		expect(r.head).toBe(head);
		expect(r.favicon).toBeNull();
		expect(r.canonical).toBeNull();
		expect(r.extraLinks).toEqual([]);
		expect(r.extraJsonLd).toEqual([]);
		expect(r.googleFontsPreconnect).toBe(false);
	});

	it('a route with no head gets the base defaults, as head.tsx always did', () => {
		const empty = { title: '', meta: [], links: [], styles: [], scripts: [], frontmatter: {} } as unknown as Head;
		const r = resolveHead(empty, '/', identity, sources());
		expect(r.head.meta.length).toBeGreaterThan(0);
		expect(meta(r.head, 'og:type')).toHaveLength(1);
	});
});

describe('resolveHead: precedence (per-path declaration > route head > head.json > base)', () => {
	it('a per-path title beats the route title (e.g. /blog/), and og:title and twitter:title follow, once each', () => {
		const head = routeHead({ title: `Journal — Store`, description: 'Route description' });
		const r = resolveHead(head, '/blog/', identity, sources({}, { '/blog/': { title: 'The Journal' } }));
		expect(r.head.title).toBe('The Journal | Store');
		expect(meta(r.head, 'og:title').map((m) => m.content)).toEqual(['The Journal']);
		expect(meta(r.head, 'twitter:title').map((m) => m.content)).toEqual(['The Journal']);
		expect(meta(r.head, 'description').map((m) => m.content)).toEqual(['Route description']);
	});

	it('head.json ogImage: alt false drops og:image:alt; width/height add the size tags (only with an og:image)', () => {
		const head = routeHead({ title: 'Shirts', description: 'D', image: '/social-image.jpg' });
		const r = resolveHead(head, '/', identity, sources({ ogImage: { alt: false, width: 1200, height: 630 } }));
		expect(meta(r.head, 'og:image:alt')).toEqual([]);
		expect(meta(r.head, 'og:image:width').map((m) => m.content)).toEqual(['1200']);
		expect(meta(r.head, 'og:image:height').map((m) => m.content)).toEqual(['630']);
		const w = resolveHead(head, '/', identity, sources({ ogImage: { width: 1200 } }));
		expect(meta(w.head, 'og:image:width').map((m) => m.content)).toEqual(['1200']);
		expect(meta(w.head, 'og:image:height')).toEqual([]);
	});

	it('og:image:alt is the page title and follows a declared title; no fixed og:image width/height', () => {
		const head = routeHead({ title: 'Shirts', description: 'D', image: '/social-image.jpg' });
		expect(meta(head as never, 'og:image:alt').map((m) => m.content)).toEqual(['Shirts']);
		expect(meta(head as never, 'og:image:width')).toEqual([]);
		expect(meta(head as never, 'og:image:height')).toEqual([]);
		const r = resolveHead(head, '/', identity, sources({}, { '/': { title: "Men's Shirts, Made to Last" } }));
		expect(meta(r.head, 'og:image:alt').map((m) => m.content)).toEqual(["Men's Shirts, Made to Last"]);
	});

	it('a per-path description beats the route description and replaces og/twitter description', () => {
		const head = routeHead({ title: 'Shop', description: 'Route description' });
		const r = resolveHead(head, '/shop/', identity, sources({ defaultDescription: 'Default' }, { '/shop/': { description: 'Declared' } }));
		for (const k of ['description', 'og:description', 'twitter:description']) expect(meta(r.head, k).map((m) => m.content), k).toEqual(['Declared']);
	});

	it('head.json defaultDescription applies only when the route has none', () => {
		const withRoute = resolveHead(routeHead({ title: 'Shop', description: 'Route description' }), '/shop/', identity, sources({ defaultDescription: 'Default' }));
		expect(meta(withRoute.head, 'description').map((m) => m.content)).toEqual(['Route description']);
		const noDescription = { title: 'T', meta: [{ property: 'og:type', content: 'website' }], links: [], styles: [], scripts: [], frontmatter: {} } as unknown as Head;
		const r = resolveHead(noDescription, '/x/', identity, sources({ defaultDescription: 'Default' }));
		expect(meta(r.head, 'description').map((m) => m.content)).toEqual(['Default']);
		expect(meta(r.head, 'og:description').map((m) => m.content)).toEqual(['Default']);
	});

	it('titleTemplate "%s" drops the store suffix; "%s | {store}" keeps it; a declared title takes the template', () => {
		const head = routeHead({ title: 'Shop', description: 'D' });
		expect(resolveHead(head, '/shop/', identity, sources({ titleTemplate: '%s' })).head.title).toBe('Shop');
		expect(resolveHead(head, '/shop/', identity, sources({ titleTemplate: '%s | {store}' })).head.title).toBe('Shop | Store');
		expect(resolveHead(head, '/shop/', identity, sources({ titleTemplate: '%s' }, { '/shop/': { title: 'Browse' } })).head.title).toBe('Browse');
		expect(resolveHead(head, '/shop/', identity, sources({ titleTemplate: '%s | {store}' }, { '/shop/': { title: 'Browse' } })).head.title).toBe('Browse | Store');
		const home = routeHead({ title: 'Store', description: 'D' });
		expect(resolveHead(home, '/', identity, sources({ titleTemplate: '%s | {store}' }, { '/': { title: 'Store' } })).head.title).toBe('Store');
	});

	it('declared noindex true and false both win over the route, and the robots meta stays unique', () => {
		const indexable = routeHead({ title: 'A', description: 'D', noindex: false });
		const hidden = routeHead({ title: 'A', description: 'D', noindex: true });
		const toHidden = resolveHead(indexable, '/a/', identity, sources({}, { '/a/': { noindex: true } }));
		expect(meta(toHidden.head, 'robots').map((m) => m.content)).toEqual(['noindex, nofollow, noai, noimageai']);
		const toIndexable = resolveHead(hidden, '/a/', identity, sources({}, { '/a/': { noindex: false } }));
		expect(meta(toIndexable.head, 'robots').map((m) => m.content)).toEqual(['noai, noimageai']);
		// not declared: the route's value stands
		expect(meta(resolveHead(hidden, '/a/', identity, sources()).head, 'robots')[0].content).toBe('noindex, nofollow, noai, noimageai');
	});

	it('canonical policy: lowercase, trailing slash, og:url follows; one canonical link; the route canonical is normalised', () => {
		const head = routeHead({ title: 'A', description: 'D', canonical: 'https://store.example/Shop/Long-Sleeve', ogUrl: 'https://store.example/Shop/Long-Sleeve' });
		const r = resolveHead(head, '/Shop/Long-Sleeve', identity, sources({ canonical: { lowercase: true, trailingSlash: 'always' } }));
		const canon = (r.head.links as { rel: string; href: string }[]).filter((l) => l.rel === 'canonical');
		expect(canon.map((l) => l.href)).toEqual(['https://store.example/shop/long-sleeve/']);
		expect(meta(r.head, 'og:url').map((m) => m.content)).toEqual(['https://store.example/shop/long-sleeve/']);
		// no route canonical: the default is built from origin + pathname under the policy
		const noCanon = resolveHead(routeHead({ title: 'A', description: 'D' }), '/About/', identity, sources({ canonical: { lowercase: true, trailingSlash: 'keep' } }));
		expect(noCanon.canonical).toBe('https://store.example/about/');
		expect(meta(noCanon.head, 'og:url').map((m) => m.content)).toEqual(['https://store.example/about/']);
		expect(canonicalHref({ lowercase: false, trailingSlash: 'always' }, 'https://s', '/A')).toBe('https://s/A/');
		expect(canonicalHref({ lowercase: false, trailingSlash: 'keep' }, 'https://s', '/A')).toBe('https://s/A');
	});

	it('exactly one favicon spec is returned (the base icon is replaced, never both)', () => {
		const r = resolveHead(routeHead({ title: 'A', description: 'D' }), '/', identity, sources({ favicon: { svg: '/brand/f.svg', ico: '/brand/f.ico' } }));
		expect(r.favicon).toEqual({ svg: '/brand/f.svg', ico: '/brand/f.ico' });
	});

	it('googleFontsPreconnect true is surfaced; default is off (the base imports no Google font)', () => {
		expect(resolveHead(routeHead({ title: 'A', description: 'D' }), '/', identity, sources({ googleFontsPreconnect: true })).googleFontsPreconnect).toBe(true);
		expect(resolveHead(routeHead({ title: 'A', description: 'D' }), '/', identity, sources({ googleFontsPreconnect: false })).googleFontsPreconnect).toBe(false);
	});
});

describe('resolveHead: preloads', () => {
	it('a path ending in * matches every path under its prefix', () => {
		const spec = { fontPreloads: [{ href: '/fonts/a.woff2', type: 'font/woff2' as const, paths: ['/blog/*'] }] };
		expect(resolveHead(routeHead({ title: 'A', description: 'D' }), '/blog/a-post/', identity, sources(spec)).extraLinks.map((l) => l.href)).toEqual(['/fonts/a.woff2']);
		expect(resolveHead(routeHead({ title: 'A', description: 'D' }), '/blog/', identity, sources(spec)).extraLinks).toHaveLength(1);
		expect(resolveHead(routeHead({ title: 'A', description: 'D' }), '/blogs/', identity, sources(spec)).extraLinks).toHaveLength(0);
		expect(resolveHead(routeHead({ title: 'A', description: 'D' }), '/', identity, sources(spec)).extraLinks).toHaveLength(0);
	});

	const spec: BrandHeadSpec = {
		fontPreloads: [{ href: '/fonts/a.woff2', type: 'font/woff2' }, { href: '/fonts/shop.woff2', type: 'font/woff2', paths: ['/shop/'] }],
		imagePreloads: [{ paths: ['/'], type: 'image/avif', fetchpriority: 'high', srcset: [{ href: '/brand/h-640.avif', width: 640 }, { href: '/brand/h-1024.avif', width: 1024 }], sizes: '(max-width: 640px) 100vw, 640px' }],
	};

	it('brand preloads for the path follow the route preloads; fonts without `paths` apply everywhere', () => {
		const home = resolveHead(routeHead({ title: 'S', description: 'D' }), '/', identity, sources(spec));
		expect(home.extraLinks.map((l) => l.href)).toEqual(['/fonts/a.woff2', '/brand/h-640.avif']);
		const shop = resolveHead(routeHead({ title: 'S', description: 'D' }), '/shop/', identity, sources(spec));
		expect(shop.extraLinks.map((l) => l.href)).toEqual(['/fonts/a.woff2', '/fonts/shop.woff2']);
		expect(home.extraLinks[1]).toMatchObject({ as: 'image', imagesrcset: '/brand/h-640.avif 640w, /brand/h-1024.avif 1024w', imagesizes: '(max-width: 640px) 100vw, 640px', fetchpriority: 'high' });
	});

	it('is deduplicated by href and imagesrcset against the route\'s own preloads and against itself', () => {
		const head = routeHead({ title: 'S', description: 'D', links: [{ rel: 'preload', as: 'font', type: 'font/woff2', href: '/fonts/a.woff2' }, { rel: 'preload', as: 'image', imagesrcset: '/brand/h-640.avif 640w, /brand/h-1024.avif 1024w' }] });
		const r = resolveHead(head, '/', identity, sources({ ...spec, fontPreloads: [...spec.fontPreloads!, { href: '/fonts/a.woff2', type: 'font/woff2' }] }));
		expect(r.extraLinks).toEqual([]);
	});
});

describe('resolveHead: static schemas', () => {
	const about = { '@context': 'https://schema.org', '@type': 'AboutPage', '@id': 'https://store.example/about/#page', name: 'About' } as const;

	it('adds the path\'s schemas after the route\'s and escapes < so </script> cannot close the element', () => {
		const r = resolveHead(routeHead({ title: 'S', description: 'D' }), '/about/', identity, sources({ pageSchemas: { '/about/': [{ ...about, name: 'a </script><script>alert(1)</script>' }] } }));
		expect(r.extraJsonLd).toHaveLength(1);
		expect(r.extraJsonLd[0]).not.toContain('</script>');
		expect(r.extraJsonLd[0]).toContain('\\u003c/script>');
		expect(JSON.parse(r.extraJsonLd[0]).name).toBe('a </script><script>alert(1)</script>');
		expect(serialiseJsonLd({ a: '<' })).toBe('{"a":"\\u003c"}');
	});

	it('drops a schema whose @id the route already emitted, and a second BreadcrumbList', () => {
		const routeSchemas = [
			{ '@context': 'https://schema.org', '@type': 'AboutPage', '@id': 'https://store.example/about/#page', name: 'Route' },
			{ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] },
		];
		const head = routeHead({ title: 'S', description: 'D', schemas: routeSchemas as never });
		const r = resolveHead(head, '/about/', identity, sources({ pageSchemas: { '/about/': [about as never, { '@type': 'BreadcrumbList', itemListElement: [] } as never, { '@type': 'Person', name: 'N' } as never] } }));
		expect(r.extraJsonLd.map((j) => JSON.parse(j)['@type'])).toEqual(['Person']);
	});

	it('two brand BreadcrumbLists on one path keep the first', () => {
		const r = resolveHead(routeHead({ title: 'S', description: 'D' }), '/p/', identity, sources({ pageSchemas: { '/p/': [{ '@type': 'BreadcrumbList' } as never, { '@type': 'BreadcrumbList' } as never] } }));
		expect(r.extraJsonLd).toHaveLength(1);
	});

	it('nothing is added for a path without declarations', () => {
		expect(resolveHead(routeHead({ title: 'S', description: 'D' }), '/other/', identity, sources({ pageSchemas: { '/about/': [about as never] } })).extraJsonLd).toEqual([]);
	});
});

describe('contentHead (declared content paths)', () => {
	it('uses the declaration, is indexable by default, and never carries the 404 title or noindex', () => {
		const head = contentHead({ path: '/about/our-story/', pageKey: 's', head: { title: 'Our story', description: 'The story.' } }, { ...(identity as object), ogImageUrl: '/og.png' } as never) as { title: string; meta: { name?: string; property?: string; content?: string }[]; links?: { rel: string; href: string }[] };
		expect(head.title).toBe('Our story | Store');
		expect(head.title).not.toMatch(/404/);
		expect(head.meta.find((m) => m.name === 'robots')?.content).toBe('noai, noimageai');
		expect(head.meta.find((m) => m.name === 'description')?.content).toBe('The story.');
		expect(head.links?.find((l) => l.rel === 'canonical')?.href).toBe('https://store.example/about/our-story/');
		expect(head.meta.find((m) => m.property === 'og:url')?.content).toBe('https://store.example/about/our-story/');
	});

	it('honours a declared noindex and falls back to the store name and tagline', () => {
		const head = contentHead({ path: '/a/b/', pageKey: 'k', head: { noindex: true } }, identity) as { title: string; meta: { name?: string; content?: string }[] };
		expect(head.meta.find((m) => m.name === 'robots')?.content).toBe('noindex, nofollow, noai, noimageai');
		expect(head.title).toBe('Store');
		expect(head.meta.find((m) => m.name === 'description')?.content).toBe('Tag line');
	});
});

describe('analytics: CSP and the GTM loader', () => {
	it('analyticsCsp is undefined without analytics and lists exactly the GTM origins with it', () => {
		expect(analyticsCsp(undefined)).toBeUndefined();
		expect(analyticsCsp(null)).toBeUndefined();
		const csp = analyticsCsp({ provider: 'gtm', containerId: 'GTM-ABC123', consent: 'implied' })!;
		expect(csp.script).toEqual(['https://*.googletagmanager.com']);
		expect(csp.connect).toEqual(['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com']);
		expect(buildCsp({ nonce: 'n', analytics: csp })).not.toContain('unsafe-eval');
	});

	it('adds the OpenAI pixel origins only when the brand opts in', () => {
		const csp = analyticsCsp({ provider: 'gtm', containerId: 'GTM-ABC123', consent: 'implied', adPlatforms: ['openai'] })!;
		expect(csp.script).toEqual(['https://*.googletagmanager.com', 'https://bzrcdn.openai.com']);
		expect(csp.connect).toEqual(['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com', 'https://bzr.openai.com', 'https://bzrcdn.openai.com']);
		const policy = buildCsp({ nonce: 'n', analytics: csp });
		expect(policy).not.toContain('unsafe-eval');
		expect(policy.split('; ').find((d) => d.startsWith('script-src'))).not.toContain('unsafe-inline');
	});

	it('the loader is static: it reads the container id from its own data attribute and embeds none', () => {
		expect(GTM_LOADER_SOURCE).toContain("getAttribute('data-gtm-id')");
		expect(GTM_LOADER_SOURCE).toContain('https://www.googletagmanager.com/gtm.js?id=');
		expect(GTM_LOADER_SOURCE).not.toMatch(/GTM-[A-Z0-9]/);
	});
});

describe('setMeta', () => {
	it('replaces every entry of a key by one, or appends', () => {
		const m = [{ name: 'description', content: 'a' }, { name: 'description', content: 'b' }, { property: 'og:type', content: 't' }];
		expect(setMeta(m, { name: 'description' }, 'x')).toEqual([{ name: 'description', content: 'x' }, { property: 'og:type', content: 't' }]);
		const added = setMeta(m, { property: 'og:url' }, 'u');
		expect(added[added.length - 1]).toEqual({ property: 'og:url', content: 'u' });
	});
});

describe('base title fallback', () => {
	it('a head without a title keeps the default title at render time (DEFAULT_METADATA_TITLE is unchanged)', () => {
		expect(DEFAULT_METADATA_TITLE).toBeTruthy();
	});
});
