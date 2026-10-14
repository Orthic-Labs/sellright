// Pure half of the brand head (plan §2.4; the component half is head.tsx, which re-exports this). No Qwik component code, so unit tests
// and the Express entry can import it. The document head a brand can shape through DATA (src/brand/head.json, routes.json), never code.
// `resolveHead` merges the declared sources with the route's own head by one precedence rule; `<BrandHeadTags>` renders the extra
// tags; `analyticsCsp` derives the CSP additions. The L1 renderer owns sanitisation, nonces, deduplication and the live commerce
// JSON-LD, so a brand cannot inject script or commerce facts. With no head.json / routes.json every function returns today's head.
import type { DocumentHead, ResolvedDocumentHead } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { generateDocumentHead } from '~/utils';
import { BRAND_HEAD, BRAND_ROUTES, DECLARED_CONTENT } from '~/platform/brand-data';
import { matchDeclaredPath, type DeclaredContent } from '~/platform/content-routes';
import type { SrStoreIdentity } from '~/utils/sellright';

/** A JSON-LD object a brand declares for a page (allowlisted at build: see brand-data/static-schema.ts). */
export type StaticSchema = { '@type': string | string[]; '@context'?: string; [key: string]: unknown };

export interface BrandHeadSpec {
	titleTemplate?: '%s | {store}' | '%s';
	defaultDescription?: string;
	canonical?: { lowercase: boolean; trailingSlash: 'keep' | 'always' };
	favicon?: { svg?: string; ico?: string };
	/** `paths`: exact paths, or a prefix ending in `*` (`/blog/*` is every path under /blog/, /blog/ included). */
	fontPreloads?: { href: string; type: 'font/woff2'; paths?: string[] }[];
	imagePreloads?: {
		paths: string[];
		type: 'image/avif' | 'image/webp' | 'image/jpeg';
		fetchpriority?: 'high' | 'auto';
		/** `href`: a public `/brand/...` URL, or a brand media import (`~/brand/media/x.png?...&url`) the build turns into its hashed URL. */
		srcset: { href: string; width: number }[];
		sizes: string;
	}[];
	googleFontsPreconnect?: boolean;
	verification?: { facebookDomain?: string; pinterest?: string };
	analytics?: { provider: 'gtm'; containerId: string; consent: 'required' | 'implied' } | null;
	serviceWorker?: 'register-ios-privacy' | 'unregister-ios-privacy' | 'none';
	appleTitle?: 'storeName';
	pageSchemas?: Record<string, StaticSchema[]>;
}

type PageHead = { title?: string; description?: string; noindex?: boolean };

export interface HeadSources {
	spec: BrandHeadSpec;
	/** Per-path declarations: `content[].head` for a declared path, `pages[path].head` for a built-in path. */
	declaration: (pathname: string) => PageHead | null;
}

const withSlash = (p: string) => (p.endsWith('/') ? p : `${p}/`);

/** A declared path list matches `path` (trailing-slashed) exactly, or by prefix for an entry ending in `*`. */
export const pathListMatches = (paths: readonly string[], path: string): boolean =>
	paths.some((p) => (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : p === path));

export const DEFAULT_SOURCES: HeadSources = {
	spec: BRAND_HEAD,
	declaration: (pathname) => {
		const path = withSlash(pathname);
		return matchDeclaredPath(DECLARED_CONTENT, path)?.head ?? BRAND_ROUTES?.pages?.[path]?.head ?? null;
	},
};

// ---------------------------------------------------------------------------------------------------- pure helpers

type Meta = { name?: string; property?: string; content?: string; [k: string]: unknown };
type Link = { rel?: string; href?: string; imagesrcset?: string; [k: string]: unknown };

const metaKey = (m: Meta) => (m.name ? `name:${m.name}` : m.property ? `property:${m.property}` : '');

/** A copy of `meta` where every entry with the same name/property is replaced by one entry with `content`; added at the end when absent. */
export function setMeta(meta: readonly Meta[], key: { name?: string; property?: string }, content: string): Meta[] {
	const k = key.name ? `name:${key.name}` : `property:${key.property}`;
	let placed = false;
	const out: Meta[] = [];
	for (const m of meta) {
		if (metaKey(m) !== k) { out.push(m); continue; }
		if (!placed) { out.push({ ...m, content }); placed = true; }
	}
	if (!placed) out.push({ ...key, content });
	return out;
}

/** `canonicalHref` (plan §2.4): the canonical URL of `pathname` under the brand's policy. */
export function canonicalHref(policy: BrandHeadSpec['canonical'] | undefined, siteOrigin: string, pathname: string): string {
	let path = pathname;
	if (policy?.lowercase) path = path.toLowerCase();
	if (policy?.trailingSlash === 'always' && !path.endsWith('/')) path = `${path}/`;
	return `${siteOrigin}${path}`;
}

/** Applies the canonical policy to an absolute canonical URL (route-provided), leaving query and hash alone. */
function applyCanonicalPolicy(policy: NonNullable<BrandHeadSpec['canonical']>, href: string): string {
	try {
		const u = new URL(href);
		u.pathname = canonicalHref(policy, '', u.pathname);
		return u.toString();
	} catch {
		return href;
	}
}

const ROBOTS_INDEX = 'noai, noimageai';
const ROBOTS_NOINDEX = 'noindex, nofollow, noai, noimageai'; // utils/seo.ts

/** Strips the ` | <store>` suffix createSEOHead adds. */
const stripSuffix = (title: string, store: string) => (title.endsWith(` | ${store}`) ? title.slice(0, -` | ${store}`.length) : title);

/** Title under a template. A title that already equals the store name or carries the suffix is left alone, as createSEOHead does. */
const applyTemplate = (title: string, store: string, template: BrandHeadSpec['titleTemplate']): string => {
	if (template === '%s') return stripSuffix(title, store);
	return title === store || title.endsWith(` | ${store}`) ? title : `${title} | ${store}`;
};

const preloadKey = (l: Link) => l.href ?? l.imagesrcset ?? '';

export interface ExtraLink {
	rel: 'preload';
	as: 'font' | 'image';
	type: string;
	href: string;
	crossOrigin?: 'anonymous';
	imagesrcset?: string;
	imagesizes?: string;
	fetchpriority?: 'high' | 'auto';
}

export interface ResolvedHead {
	/** The head to render: the input object itself when nothing is declared (so today's bytes are untouched). */
	head: ResolvedDocumentHead;
	/** Replaces the base `<link rel=icon>` when set. */
	favicon: { svg?: string; ico?: string } | null;
	/** The canonical to render instead of the default, or null to keep the default / route canonical. */
	canonical: string | null;
	/** Brand preloads for this path that the route did not already preload. */
	extraLinks: ExtraLink[];
	/** Brand-declared JSON-LD for this path, serialised with `<` escaped. */
	extraJsonLd: string[];
	googleFontsPreconnect: boolean;
}

const jsonLdOf = (m: Meta): { id: string | null; types: string[] } | null => {
	if (typeof m.name !== 'string' || !m.name.startsWith('json-ld-')) return null;
	try {
		const o = JSON.parse(String(m.content ?? '')) as { '@id'?: string; '@type'?: string | string[] };
		return { id: o['@id'] ?? null, types: ([] as string[]).concat(o['@type'] ?? []) };
	} catch {
		return null;
	}
};

/** `</script>`-safe JSON for an inline ld+json element. */
export const serialiseJsonLd = (schema: unknown): string => JSON.stringify(schema).replace(/</g, '\\u003c');

/**
 * Plan §2.4 precedence. Each field resolves from the first source that sets it: (1) the brand's per-path declaration, (2) the
 * route's `head` export, (3) head.json defaults, (4) base defaults. One tag per kind is rendered.
 */
export function resolveHead(documentHead: ResolvedDocumentHead, pathname: string, identity: Pick<SrStoreIdentity, 'storeName' | 'siteOrigin'>, sources: HeadSources = DEFAULT_SOURCES): ResolvedHead {
	const { spec } = sources;
	// (4) base defaults, exactly as head.tsx always did
	const base = (documentHead.meta.length > 0 ? documentHead : { ...documentHead, ...generateDocumentHead() }) as ResolvedDocumentHead;
	const decl = sources.declaration(pathname);
	const path = withSlash(pathname);

	let head: ResolvedDocumentHead = base;
	let meta: Meta[] = [...(base.meta as readonly Meta[])];
	let links: Link[] = [...(base.links as readonly Link[])];
	let touched = false;
	const store = identity.storeName;

	// ---- title: (1) -> (2) -> default; then the template; the winner also replaces og:title / twitter:title
	let title = base.title;
	if (decl?.title) {
		title = applyTemplate(decl.title, store, spec.titleTemplate);
		meta = setMeta(meta, { property: 'og:title' }, decl.title);
		if (meta.some((m) => m.property === 'og:image:alt')) meta = setMeta(meta, { property: 'og:image:alt' }, decl.title);
		meta = setMeta(meta, { name: 'twitter:title' }, decl.title);
		touched = true;
	} else if (spec.titleTemplate === '%s' && title) {
		title = stripSuffix(title, store);
		touched = true;
	}

	// ---- description: (1) -> (2) -> defaultDescription; the winner also replaces og/twitter description
	const routeDescription = meta.find((m) => m.name === 'description' && m.content);
	if (decl?.description) {
		meta = setMeta(meta, { name: 'description' }, decl.description);
		meta = setMeta(meta, { property: 'og:description' }, decl.description);
		meta = setMeta(meta, { name: 'twitter:description' }, decl.description);
		touched = true;
	} else if (!routeDescription && spec.defaultDescription) {
		meta = setMeta(meta, { name: 'description' }, spec.defaultDescription);
		meta = setMeta(meta, { property: 'og:description' }, spec.defaultDescription);
		meta = setMeta(meta, { name: 'twitter:description' }, spec.defaultDescription);
		touched = true;
	}

	// ---- noindex: (1) a declared boolean replaces the robots meta; else (2)
	if (typeof decl?.noindex === 'boolean') {
		meta = setMeta(meta, { name: 'robots' }, decl.noindex ? ROBOTS_NOINDEX : ROBOTS_INDEX);
		touched = true;
	}

	// ---- canonical / og:url: policy applies to the route canonical, or to the default (origin + pathname); og:url = the canonical
	let canonical: string | null = null;
	if (spec.canonical) {
		const routeCanonical = links.find((l) => l.rel === 'canonical' && l.href);
		canonical = routeCanonical?.href ? applyCanonicalPolicy(spec.canonical, routeCanonical.href) : canonicalHref(spec.canonical, identity.siteOrigin, pathname);
		if (routeCanonical) links = links.map((l) => (l === routeCanonical ? { ...l, href: canonical as string } : l));
		meta = setMeta(meta, { property: 'og:url' }, canonical);
		touched = true;
	}

	// ---- brand preloads for this path, after the route's own, deduplicated by href / imagesrcset
	const have = new Set(links.filter((l) => l.rel === 'preload').map(preloadKey).filter(Boolean));
	const extraLinks: ExtraLink[] = [];
	for (const f of spec.fontPreloads ?? []) {
		if (f.paths && !pathListMatches(f.paths, path)) continue;
		if (have.has(f.href)) continue;
		have.add(f.href);
		extraLinks.push({ rel: 'preload', as: 'font', type: f.type, href: f.href, crossOrigin: 'anonymous' });
	}
	for (const im of spec.imagePreloads ?? []) {
		if (!pathListMatches(im.paths, path)) continue;
		const imagesrcset = im.srcset.map((s) => `${s.href} ${s.width}w`).join(', ');
		const href = im.srcset[0].href;
		if (have.has(href) || have.has(imagesrcset)) continue;
		have.add(href);
		have.add(imagesrcset);
		extraLinks.push({ rel: 'preload', as: 'image', type: im.type, href, imagesrcset, imagesizes: im.sizes, ...(im.fetchpriority ? { fetchpriority: im.fetchpriority } : {}) });
	}

	// ---- static schemas: after the route's (live commerce JSON-LD stays with the route); a repeated @id or a second BreadcrumbList is dropped
	const seenIds = new Set<string>();
	let hasCrumbs = false;
	for (const m of meta) {
		const j = jsonLdOf(m);
		if (!j) continue;
		if (j.id) seenIds.add(j.id);
		if (j.types.includes('BreadcrumbList')) hasCrumbs = true;
	}
	const extraJsonLd: string[] = [];
	for (const s of spec.pageSchemas?.[path] ?? []) {
		const types = ([] as string[]).concat(s['@type']);
		const id = typeof s['@id'] === 'string' ? s['@id'] : null;
		if (id && seenIds.has(id)) continue;
		if (types.includes('BreadcrumbList')) { if (hasCrumbs) continue; hasCrumbs = true; }
		if (id) seenIds.add(id);
		extraJsonLd.push(serialiseJsonLd(s));
	}

	if (touched) head = { ...base, title: title ?? base.title, meta: meta as ResolvedDocumentHead['meta'], links: links as ResolvedDocumentHead['links'] };
	return {
		head,
		favicon: spec.favicon ?? null,
		canonical,
		extraLinks,
		extraJsonLd,
		googleFontsPreconnect: spec.googleFontsPreconnect === true,
	};
}

/**
 * The head of a declared content path: the declaration's title, description, canonical and og:url, `noindex` from the
 * declaration (default indexable). A declared page never carries the 404 title or `noindex` of the catch-all.
 */
export function contentHead(decl: DeclaredContent, identity: SrStoreIdentity): DocumentHead {
	const url = `${identity.siteOrigin}${decl.path}`;
	return createSEOHead({
		title: decl.head?.title ?? identity.storeName,
		description: decl.head?.description ?? identity.tagline,
		canonical: url,
		ogUrl: url,
		noindex: decl.head?.noindex ?? false,
		identity,
	});
}
