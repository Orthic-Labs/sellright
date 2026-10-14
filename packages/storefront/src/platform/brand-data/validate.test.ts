// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateJson, type JsonSchema } from './json-schema';
import { pageSchemasProblems, staticSchemaProblems } from './static-schema';
import { validateHeadData, validateHostsData, validateLicenseData, validateRoutesData } from './validate';
import { BrandDataValidationError, loadBrandData, renderBrandDataModule } from './vite-plugin';

const ROUTE_DIRS = ['about', 'blog', 'shop', 'checkout'];
const routes = (v: unknown, hasContentView = true) => validateRoutesData(v, { routeDirs: ROUTE_DIRS, hasContentView }).map((p) => p.message);
const head = (v: unknown) => validateHeadData(v).map((p) => p.message);

describe('json-schema subset', () => {
	it('rejects unknown properties, wrong types, bad enums, patterns, ranges and lengths', () => {
		const schema: JsonSchema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer', minimum: 1, maximum: 3 }, b: { enum: ['x'] }, c: { type: 'array', maxItems: 1, items: { type: 'string', pattern: '^a' } } } };
		expect(validateJson({ a: 2 }, schema)).toEqual([]);
		expect(validateJson({}, schema)).toEqual(['$: missing required "a"']);
		expect(validateJson({ a: 2, z: 1 }, schema)).toEqual(['$: unknown property "z"']);
		expect(validateJson({ a: 0 }, schema)[0]).toMatch(/below 1/);
		expect(validateJson({ a: 1.5 }, schema)[0]).toMatch(/expected integer/);
		expect(validateJson({ a: 1, b: 'y' }, schema)[0]).toMatch(/must be one of/);
		expect(validateJson({ a: 1, c: ['b'] }, schema)[0]).toMatch(/does not match/);
		expect(validateJson({ a: 1, c: ['a', 'a'] }, schema)[0]).toMatch(/at most 1/);
	});
});

describe('head.json (head sanitisation)', () => {
	it('accepts an empty spec and a full valid one', () => {
		expect(head({})).toEqual([]);
		expect(head({
			titleTemplate: '%s | {store}', defaultDescription: 'D', canonical: { lowercase: true, trailingSlash: 'always' },
			favicon: { svg: '/favicon/favicon.svg', ico: '/favicon.ico' },
			fontPreloads: [{ href: '/fonts/a.woff2', type: 'font/woff2', paths: ['/', '/shop/'] }],
			imagePreloads: [{ paths: ['/'], type: 'image/avif', fetchpriority: 'high', srcset: [{ href: '/brand/hero-640.avif', width: 640 }, { href: '/brand/hero-1024.avif', width: 1024 }], sizes: '(max-width: 640px) 100vw, 640px' }],
			googleFontsPreconnect: false, verification: { facebookDomain: 'abcdefghij1234567890' },
			analytics: { provider: 'gtm', containerId: 'GTM-ABC123', consent: 'implied' }, serviceWorker: 'none', appleTitle: 'storeName',
			pageSchemas: { '/about/': [{ '@context': 'https://schema.org', '@type': 'AboutPage', name: 'About', mainEntity: { '@type': 'Person', name: 'N' } }] },
		})).toEqual([]);
	});

	it('rejects unknown keys at every level (additionalProperties: false)', () => {
		expect(head({ script: 'x' }).join()).toMatch(/unknown property "script"/);
		expect(head({ canonical: { lowercase: true, trailingSlash: 'keep', x: 1 } }).join()).toMatch(/unknown property "x"/);
		expect(head({ analytics: { provider: 'gtm', containerId: 'GTM-ABC123', consent: 'required', pixel: 'x' } }).join()).toMatch(/unknown property "pixel"/);
	});

	it('rejects protocol-relative and absolute URLs (//evil, https://, javascript:)', () => {
		for (const href of ['//evil.example/a.woff2', 'https://evil.example/a.woff2', 'javascript:alert(1)', 'a.woff2', '/ /a.woff2', '/a"onload=x.woff2']) {
			expect(head({ fontPreloads: [{ href, type: 'font/woff2' }] }).length, href).toBeGreaterThan(0);
		}
		expect(head({ favicon: { svg: '//evil.example/f.svg' } }).length).toBeGreaterThan(0);
		expect(head({ imagePreloads: [{ paths: ['/'], type: 'image/avif', srcset: [{ href: '//evil.example/x.avif', width: 10 }], sizes: '100vw' }] }).length).toBeGreaterThan(0);
		expect(head({ imagePreloads: [{ paths: ['/'], type: 'image/avif', srcset: [{ href: '/other/x.avif', width: 10 }], sizes: '100vw' }] }).length, 'image srcset must live under /brand/').toBeGreaterThan(0);
	});

	it('rejects a bad GTM container id and any non-gtm provider (no ad pixels)', () => {
		for (const containerId of ['GTM-ab', 'GTM-', 'gtm-ABC123', 'G-ABC123', 'GTM-ABC123456789X', "GTM-A'B"]) {
			expect(head({ analytics: { provider: 'gtm', containerId, consent: 'required' } }).length, containerId).toBeGreaterThan(0);
		}
		expect(head({ analytics: { provider: 'meta-pixel', containerId: 'GTM-ABC123', consent: 'required' } }).join()).toMatch(/must be "gtm"/);
		expect(head({ analytics: null })).toEqual([]);
	});

	it('rejects bad srcset counts and widths, and a sizes string with markup', () => {
		const ok = { paths: ['/'], type: 'image/avif', sizes: '100vw' };
		expect(head({ imagePreloads: [{ ...ok, srcset: [] }] }).length).toBeGreaterThan(0);
		expect(head({ imagePreloads: [{ ...ok, srcset: Array.from({ length: 7 }, (_, i) => ({ href: `/brand/${i}.avif`, width: 10 })) }] }).length).toBeGreaterThan(0);
		expect(head({ imagePreloads: [{ ...ok, srcset: [{ href: '/brand/a.avif', width: 5000 }] }] }).length).toBeGreaterThan(0);
		expect(head({ imagePreloads: [{ ...ok, srcset: [{ href: '/brand/a.avif', width: 10 }], sizes: '"><script>' }] }).length).toBeGreaterThan(0);
	});

	it('static schemas: the typical page schemas (about, breadcrumbs, FAQ, organization, blog) pass', () => {
		const about = { '@context': 'https://schema.org', '@type': 'AboutPage', name: 'About', mainEntity: { '@type': 'Person', name: 'N', image: { '@type': 'ImageObject', url: '/brand/n.jpg' } } };
		const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://s.example/' }] };
		const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } }] };
		const org = { '@type': 'Organization', name: 'O', address: { '@type': 'PostalAddress', streetAddress: 'x' }, contactPoint: { '@type': 'ContactPoint', email: 'a@b.c' }, sameAs: ['https://x.example'], publisher: { '@id': 'https://s.example/#organization' } };
		const blog = { '@type': 'Blog', name: 'B', publisher: { '@type': 'Organization', name: 'O' } };
		for (const s of [about, crumbs, faq, org, blog]) expect(staticSchemaProblems(s, 'x'), JSON.stringify(s)).toEqual([]);
	});

	it('static schemas: a nested Offer, a Product root, price keys, ratings and reviews are rejected', () => {
		expect(staticSchemaProblems({ '@type': 'WebPage', mainEntity: { '@type': 'Offer', price: '1' } }, 'x').join()).toMatch(/Offer/);
		expect(staticSchemaProblems({ '@type': 'Product', name: 'P' }, 'x').join()).toMatch(/Product/);
		expect(staticSchemaProblems({ '@type': 'WebPage', offers: { '@type': 'Offer' } }, 'x').join()).toMatch(/platform-owned/);
		expect(staticSchemaProblems({ '@type': 'Organization', aggregateRating: { '@type': 'AggregateRating', ratingValue: 5 } }, 'x').join()).toMatch(/AggregateRating|platform-owned/);
		expect(staticSchemaProblems({ '@type': 'Article', review: [] }, 'x').join()).toMatch(/platform-owned/);
		for (const key of ['price', 'priceCurrency', 'priceRange', 'availability', 'sku', 'gtin13', 'gtin', 'mpn']) {
			expect(staticSchemaProblems({ '@type': 'WebPage', [key]: 'x' }, 'x').join(), key).toMatch(/platform-owned/);
		}
		expect(staticSchemaProblems({ '@type': ['WebPage', 'ProductGroup'] }, 'x').join()).toMatch(/ProductGroup/);
	});

	it('static schemas: root and nested allowlists, depth, string length and per-path count', () => {
		expect(staticSchemaProblems({ '@type': 'Event' }, 'x').join()).toMatch(/not an allowed root type/);
		expect(staticSchemaProblems({ '@type': 'WebPage', about: { '@type': 'Event' } }, 'x').join()).toMatch(/not an allowed nested type/);
		expect(staticSchemaProblems({ '@type': 'WebPage', about: { name: 'untyped object' } }, 'x').join()).toMatch(/needs an allowed @type/);
		expect(staticSchemaProblems({ '@type': 'WebPage', publisher: { '@id': 'https://x/#o' } }, 'x')).toEqual([]);
		expect(staticSchemaProblems({ '@type': 'WebPage', name: 'x'.repeat(2001) }, 'x').join()).toMatch(/longer than 2000/);
		const deep = { '@type': 'WebPage', a: { '@type': 'Person', b: { '@type': 'Person', c: { '@type': 'Person', d: { '@type': 'Person', e: { '@type': 'Person', f: { '@type': 'Person' } } } } } } };
		expect(staticSchemaProblems(deep, 'x').join()).toMatch(/deeper than/);
		expect(pageSchemasProblems({ '/a/': Array.from({ length: 21 }, () => ({ '@type': 'WebPage' })) }).join()).toMatch(/more than 20/);
		expect(staticSchemaProblems('x', 'x')[0]).toMatch(/must be an object/);
		expect(staticSchemaProblems({ name: 'no type' }, 'x').join()).toMatch(/needs an @type/);
	});

	it('static schemas: validateHeadData reports a forbidden schema through pageSchemas', () => {
		expect(head({ pageSchemas: { '/': [{ '@type': 'Product' }] } }).join()).toMatch(/Product/);
	});
});

describe('routes.json (content declarations)', () => {
	it('accepts a valid declaration', () => {
		expect(routes({ version: 1, content: [{ path: '/our/story/', pageKey: 'story', head: { title: 'Our story', description: 'D', noindex: false } }], pages: { '/about/': { head: { title: 'About' } } }, blog: { pageSize: 100 } })).toEqual([]);
		expect(routes({ version: 1 })).toEqual([]);
	});

	it('rejects unknown keys, a missing version and a bad page size', () => {
		expect(routes({ version: 1, nope: true }).join()).toMatch(/unknown property "nope"/);
		expect(routes({}).join()).toMatch(/missing required "version"/);
		expect(routes({ version: 1, blog: { pageSize: 0 } }).join()).toMatch(/below 1/);
		expect(routes({ version: 1, blog: { pageSize: 101 } }).join()).toMatch(/above 100/);
		expect(routes({ version: 1, blog: { pageSize: 1.5 } }).join()).toMatch(/integer/);
	});

	it('accepts a single-segment content path (served by the [key] route) unless it is a reserved or existing prefix', () => {
		expect(routes({ version: 1, content: [{ path: '/our-story/', pageKey: 'story' }] })).toEqual([]);
		expect(routes({ version: 1, content: [{ path: '/shop/', pageKey: 'story' }] }).join()).toMatch(/reserved or existing route prefix/);
		expect(routes({ version: 1, content: [{ path: '/our.story/', pageKey: 'story' }] }).join()).toMatch(/does not match/);
	});

	it('rejects reserved / existing prefixes, duplicates and a bad `pages` key at build', () => {
		expect(routes({ version: 1, content: [{ path: '/shop/care/', pageKey: 'a' }] }).join()).toMatch(/reserved or existing route prefix/);
		expect(routes({ version: 1, content: [{ path: '/api/x/', pageKey: 'a' }] }).join()).toMatch(/reserved/);
		expect(routes({ version: 1, content: [{ path: '/a/b/', pageKey: 'a' }, { path: '/a/b/', pageKey: 'b' }] }).join()).toMatch(/twice/);
		expect(routes({ version: 1, pages: { '/nope/': {} } }).join()).toMatch(/not a built-in static page/);
	});

	it('home.spotlight needs the route.home view', () => {
		const r = { version: 1, home: { spotlight: { key: 'tee', slug: 'tee' } } };
		expect(validateRoutesData(r, { routeDirs: ROUTE_DIRS, hasContentView: true, hasHomeView: false }).map((p) => p.message).join()).toMatch(/route\.home/);
		expect(validateRoutesData(r, { routeDirs: ROUTE_DIRS, hasContentView: true, hasHomeView: true })).toEqual([]);
		expect(routes({ version: 1, home: { spotlight: { key: 'Tee', slug: 'tee' } } }).join()).toMatch(/does not match/);
	});

	it('productPage: related flag and plain-text content per slug', () => {
		expect(routes({ version: 1, productPage: { related: true, content: { 'oni': { designNote: 'Note.', faqs: [{ q: 'Q?', a: 'A.' }] } } } })).toEqual([]);
		expect(routes({ version: 1, productPage: { content: { 'oni': { designNote: '<b>x</b>' } } } }).join()).toMatch(/does not match/);
		expect(routes({ version: 1, productPage: { content: { 'Bad Slug': {} } } }).join()).toMatch(/property name/);
	});

	it('content paths without a route.content view fail the build', () => {
		expect(routes({ version: 1, content: [{ path: '/a/b/', pageKey: 'a' }] }, false).join()).toMatch(/route\.content/);
		expect(routes({ version: 1 }, false)).toEqual([]);
	});
});

describe('loadBrandData / virtual module', () => {
	const dirs: string[] = [];
	const makeRoot = (files: Record<string, string>, slots: string[] = []) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-brand-data-'));
		dirs.push(root);
		fs.mkdirSync(path.join(root, 'src/routes/about'), { recursive: true });
		fs.mkdirSync(path.join(root, 'src/brand'), { recursive: true });
		fs.mkdirSync(path.join(root, 'src/brand-slots'), { recursive: true });
		for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'src/brand', rel), text);
		for (const s of slots) fs.writeFileSync(path.join(root, 'src/brand-slots', s), 'x');
		return root;
	};
	const load = (root: string) => loadBrandData(root, path.join(root, 'src/brand'), path.join(root, 'src/brand-slots'));
	afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

	it('a missing head.json and routes.json means defaults (null)', () => {
		expect(load(makeRoot({}))).toEqual({ head: null, routes: null, hosts: null, license: null });
		expect(renderBrandDataModule({ head: null, routes: null })).toBe('export const brandHead = null;\nexport const brandRoutes = null;\nexport const brandHosts = null;\nexport const brandLicense = null;\n');
	});

	it('valid files load and render', () => {
		const root = makeRoot({ 'head.json': '{"titleTemplate":"%s"}', 'routes.json': '{"version":1,"content":[{"path":"/our/story/","pageKey":"s"}]}' }, ['route.content.tsx']);
		const data = load(root);
		expect(data.head).toEqual({ titleTemplate: '%s' });
		expect(renderBrandDataModule(data)).toContain('"/our/story/"');
	});

	it('a brand media import in imagePreloads becomes an import of that asset (the build-hashed URL); a missing file fails', () => {
		const spec = { imagePreloads: [{ paths: ['/'], type: 'image/avif', sizes: '100vw', srcset: [{ href: '~/brand/media/hero.png?format=avif&w=768&url', width: 768 }, { href: '/brand/hero-1600.avif', width: 1600 }, { href: '~/brand/media/hero.png?format=avif&w=768&url', width: 769 }] }] };
		const root = makeRoot({ 'head.json': JSON.stringify(spec) });
		fs.mkdirSync(path.join(root, 'src/brand/media'));
		fs.writeFileSync(path.join(root, 'src/brand/media/hero.png'), 'x');
		const src = renderBrandDataModule(load(root));
		expect(src.split('\n')[0]).toBe('import __brandMedia0 from "~/brand/media/hero.png?format=avif&w=768&url";');
		expect(src.match(/^import /gm)).toHaveLength(1);
		expect(src).toContain('{"href":__brandMedia0,"width":768},{"href":"/brand/hero-1600.avif","width":1600},{"href":__brandMedia0,"width":769}');
		expect(renderBrandDataModule(load(root), { srcDir: path.join(root, 'src') }).split('\n')[0]).toBe(`import __brandMedia0 from ${JSON.stringify(path.join(root, 'src/brand/media/hero.png') + '?format=avif&w=768&url')};`);
		fs.rmSync(path.join(root, 'src/brand/media/hero.png'));
		expect(() => load(root)).toThrow(/names no file/);
		expect(head({ imagePreloads: [{ ...spec.imagePreloads[0], srcset: [{ href: '~/brand/media/../x.png?url', width: 1 }] }] }).join()).toMatch(/does not match/);
		expect(head({ imagePreloads: [{ ...spec.imagePreloads[0], srcset: [{ href: '~/brand/media/x.png?format=avif', width: 1 }] }] }).join()).toMatch(/does not match/);
	});

	it('any problem fails the build with every problem listed', () => {
		const root = makeRoot({ 'head.json': '{"script":"x"}', 'routes.json': '{"version":1,"content":[{"path":"/about/x/","pageKey":"s"}]}' });
		let err: unknown;
		try { load(root); } catch (e) { err = e; }
		expect(err).toBeInstanceOf(BrandDataValidationError);
		expect((err as BrandDataValidationError).message).toMatch(/head\.json/);
	});

	it('invalid JSON fails the build', () => {
		expect(() => load(makeRoot({ 'head.json': '{' }))).toThrow(BrandDataValidationError);
	});

	it('a symlinked data file is rejected', () => {
		const root = makeRoot({});
		fs.writeFileSync(path.join(root, 'real.json'), '{}');
		fs.symlinkSync(path.join(root, 'real.json'), path.join(root, 'src/brand/head.json'));
		expect(() => load(root)).toThrow(/regular file/);
	});

	it('the virtual module is imported from exactly one app file', () => {
		const src = path.resolve(__dirname, '../..');
		const hits: string[] = [];
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /from 'virtual:sellright-brand-data'/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(src, p));
			}
		};
		walk(src);
		expect(hits).toEqual(['platform/brand-data/index.ts']);
	});
});

describe('routes.json PR2 part (productPath, shop, operational)', () => {
	const shop = (over: Record<string, unknown> = {}) => ({
		version: 1,
		productPath: '/shop/:slug/',
		shop: {
			detailProducts: [
				{ key: 'short', slug: 'shortsleeveshirt', head: { title: 'Short', description: 'D' }, breadcrumbName: 'Short shirt', schemas: [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] }] },
				{ key: 'long', slug: 'longsleeveshirt' },
			],
			productQuery: { params: ['style', 'sleeve'], values: { short: 'short', long: 'long' } },
		},
		operational: { cartSeedPath: '/checkout/facebook/', analyticsPath: '/api/analytics/performance/' },
		...over,
	});
	const v = (value: unknown, views = { hasShopView: true, hasProductView: true }) =>
		validateRoutesData(value, { routeDirs: ['shop', 'products', 'checkout', 'api'], hasContentView: false, ...views }).map((p) => p.message).join(' | ');

	it("accepts Rotten's shape", () => {
		expect(v(shop())).toBe('');
	});
	it('rejects a commerce schema, an unknown product key in the query, duplicates, alias collisions and a bad productPath', () => {
		expect(v(shop({ shop: { detailProducts: [{ key: 'a', slug: 's', schemas: [{ '@type': 'Product', offers: {} }] }] } }))).toMatch(/platform-owned/);
		expect(v(shop({ shop: { detailProducts: [{ key: 'a', slug: 's' }], productQuery: { params: ['style'], values: { x: 'nope' } } } }))).toMatch(/not a shop.detailProducts key/);
		expect(v(shop({ shop: { detailProducts: [{ key: 'a', slug: 's' }, { key: 'a', slug: 's' }] } }))).toMatch(/declared twice/);
		expect(v(shop({ operational: { cartSeedPath: '/checkout/confirmation/' } }))).toMatch(/collides/);
		expect(v(shop({ operational: { analyticsPath: '/api/analytics/events/' } }))).toMatch(/collides/);
		expect(v(shop({ productPath: '/p/:slug/' }))).not.toBe('');
		expect(v(shop({ shop: { detailProducts: [{ key: 'a', slug: 's', head: { title: '<b>', description: 'x' } }] } }))).not.toBe('');
		expect(v(shop(), { hasShopView: false, hasProductView: false })).toMatch(/only the brand views read them/);
		// listingOrder and priceDisplay are read by the base shop listing: no view needed
		expect(v({ version: 1, shop: { listingOrder: ['a-b', 'c'], priceDisplay: 'range' } }, { hasShopView: false, hasProductView: false })).toBe('');
		expect(v({ version: 1, shop: { priceDisplay: 'max' } }, { hasShopView: false, hasProductView: false })).toMatch(/must be one of/);
	});
	it('accepts CollectionPage with an ItemList for /shop/ (head.json pageSchemas)', () => {
		expect(validateHeadData({ pageSchemas: { '/shop/': [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Shop', mainEntity: { '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', position: 1, url: 'https://x/shop/a/', name: 'A' }] } }] } })).toEqual([]);
	});
});

const VARIANT = { key: 'alpha', name: 'Alpha', wordmark: ['Al', 'pha'], domain: 'alpha.test', collection: 'alpha', tokens: { '--accent': '#112233', '--font-body': 'Inter' } };
const HOSTS = { version: 1, stripPrefixes: ['store', 'www'], default: 'alpha.test', hosts: { 'alpha.test': VARIANT, 'beta.test': { key: 'beta', name: 'Beta', domain: 'beta.test', tokens: {} } } };
const DOC = { role: 'eula', id: 'x-eula', version: '1.1', sha256: 'a'.repeat(64), url: 'https://alpha.test/legal/eula/', treatment: 'agree' };
const DOCS = (['license', 'eula', 'acceptable_use', 'product_schedule', 'privacy_notice'] as const).map((role) => ({ ...DOC, role, id: `x-${role}`, treatment: role === 'privacy_notice' ? 'acknowledge' : 'agree' }));
const LICENSE = {
	version: 1,
	seller: { line: 'Example LLC', supportLocalPart: 'hello' },
	pausedAppKeys: ['beta'],
	contracts: { alpha: { acceptanceVersion: 'alpha-v1', agreementStatement: 'I agree.', documents: DOCS } },
	confirmationLegalLinks: { default: { privacy: '/privacy', terms: '/terms', refund: '/refund', contact: '/contact' } },
	devices: { endpoint: '/v1/shop/account/devices' },
	upgradeCredit: { endpoint: '/v1/shop/pro/mobile-upgrade', appKey: 'alpha', sku: 'AL-PRO', creditTermsVersion: '2026-09-30', sourceName: 'Mobile', targetName: 'Full', storeName: 'App Store' },
};
const msgs = (problems: { message: string }[]) => problems.map((p) => p.message);

describe('hosts.json (per-host variants)', () => {
	it('accepts a valid file', () => {
		expect(validateHostsData(HOSTS)).toEqual([]);
	});
	it('rejects a default that names no host, a duplicate key, bad host names and unsafe token names or values', () => {
		expect(msgs(validateHostsData({ ...HOSTS, default: 'gamma.test' })).join()).toMatch(/default gamma\.test is not a key of hosts/);
		expect(msgs(validateHostsData({ ...HOSTS, hosts: { ...HOSTS.hosts, 'gamma.test': { ...VARIANT } } })).join()).toMatch(/key alpha is declared twice/);
		expect(msgs(validateHostsData({ ...HOSTS, hosts: { 'Alpha.Test': VARIANT } })).join()).toMatch(/does not match/);
		expect(msgs(validateHostsData({ ...HOSTS, hosts: { 'alpha.test': { ...VARIANT, tokens: { accent: '#fff' } } } })).join()).toMatch(/does not match/);
		for (const bad of ['red;}body{x:y', 'url("x")', '<b>']) {
			expect(msgs(validateHostsData({ ...HOSTS, hosts: { 'alpha.test': { ...VARIANT, tokens: { '--accent': bad } } } })).join(), bad).toMatch(/does not match/);
		}
		expect(msgs(validateHostsData({ ...HOSTS, extra: 1 })).join()).toMatch(/unknown property "extra"/);
	});
});

describe('license.json (license flow data)', () => {
	it('accepts a valid file and a minimal one', () => {
		expect(validateLicenseData(LICENSE)).toEqual([]);
		expect(validateLicenseData({ version: 1, seller: { line: 'x', supportLocalPart: 'support' } })).toEqual([]);
	});
	it('rejects a repeated document role, a non-https document URL, a bad sha256, an endpoint outside /v1/shop and an absolute confirmation link', () => {
		expect(msgs(validateLicenseData({ ...LICENSE, contracts: { alpha: { ...LICENSE.contracts.alpha, documents: [...DOCS, DOC] } } })).join()).toMatch(/role is listed twice/);
		for (const role of ['license', 'eula', 'acceptable_use', 'product_schedule', 'privacy_notice']) {
			const documents = DOCS.filter((d) => d.role !== role);
			expect(msgs(validateLicenseData({ ...LICENSE, contracts: { alpha: { ...LICENSE.contracts.alpha, documents } } })).join(), role).toMatch(new RegExp(`missing document role\\(s\\) ${role}`));
		}
		expect(msgs(validateLicenseData({ ...LICENSE, contracts: { alpha: { ...LICENSE.contracts.alpha, documents: [{ ...DOC, url: 'http://alpha.test/x' }] } } })).join()).toMatch(/does not match/);
		expect(msgs(validateLicenseData({ ...LICENSE, contracts: { alpha: { ...LICENSE.contracts.alpha, documents: [{ ...DOC, sha256: 'abc' }] } } })).join()).toMatch(/does not match/);
		expect(msgs(validateLicenseData({ ...LICENSE, devices: { endpoint: 'https://evil.test/v1' } })).join()).toMatch(/does not match/);
		expect(msgs(validateLicenseData({ ...LICENSE, devices: { endpoint: '/v1/admin/x' } })).join()).toMatch(/does not match/);
		expect(msgs(validateLicenseData({ ...LICENSE, confirmationLegalLinks: { default: { privacy: 'https://x.test/', terms: '/t', refund: '/r', contact: '/c' } } })).join()).toMatch(/does not match/);
	});
	it('hosts.json and license.json load into the virtual module; an invalid one fails the build', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-brand-data-'));
		try {
			fs.mkdirSync(path.join(dir, 'src/brand'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'src/brand/hosts.json'), JSON.stringify(HOSTS));
			fs.writeFileSync(path.join(dir, 'src/brand/license.json'), JSON.stringify(LICENSE));
			const data = loadBrandData(dir, path.join(dir, 'src/brand'), path.join(dir, 'src/brand-slots'));
			expect(data.hosts).toEqual(HOSTS);
			expect(data.license).toEqual(LICENSE);
			expect(renderBrandDataModule(data)).toContain(`export const brandHosts = ${JSON.stringify(HOSTS)};`);
			fs.writeFileSync(path.join(dir, 'src/brand/hosts.json'), JSON.stringify({ ...HOSTS, default: 'nope.test' }));
			expect(() => loadBrandData(dir, path.join(dir, 'src/brand'), path.join(dir, 'src/brand-slots'))).toThrow(/hosts\.json: default nope\.test/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
