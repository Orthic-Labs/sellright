// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BUILT_IN_CONTENT_PATHS, checkContentPaths, matchDeclaredPath, selectsContentView, type DeclaredContent } from './content-routes';

const ROUTE_DIRS = ['about', 'account', 'blog', 'checkout', 'contact', 'products', 'shop', '[...catchall]', '[key]', 'sign-in', 'track-order'];
const c = (path: string, pageKey = 'k'): DeclaredContent => ({ path, pageKey });
const problems = (content: DeclaredContent[], pages: Record<string, never> = {}) => checkContentPaths({ content, pages }, ROUTE_DIRS);

describe('checkContentPaths (route collisions)', () => {
	it('accepts exact lowercase hyphenated paths, nested too', () => {
		expect(problems([c('/our/story/', 'story'), c('/care/guide/', 'care')])).toEqual([]);
	});

	it('rejects a path that is not lowercase words with a leading and trailing slash', () => {
		for (const bad of ['our/story/', '/our/story', '/Our/Story/', '/our/story one/', '/our/story_one/', '/a//b/', '//evil.example/', '/a/../b/', '/a.b/c/', '/-a/b/', '/a-/b/', '/', '', '/a/b', '/our-story', '/key.txt/']) {
			expect(problems([c(bad)]).length, bad).toBeGreaterThan(0);
		}
	});

	it('accepts a single-segment path and matches it exactly', () => {
		expect(problems([c('/slow-fashion/')])).toEqual([]);
		expect(matchDeclaredPath([c('/slow-fashion/')], '/slow-fashion/')?.path).toBe('/slow-fashion/');
		expect(matchDeclaredPath([c('/slow-fashion/')], '/slow-fashion')).toBeNull();
	});

	it('rejects the fixed reserved prefixes', () => {
		for (const first of ['api', 'admin', 'assets', 'build', 'fonts', 'favicon', 'media', 'brand']) {
			expect(problems([c(`/${first}/x/`)]).join(), first).toMatch(/reserved or existing route prefix/);
		}
		expect(problems([c('/.well-known/x/')]).length).toBeGreaterThan(0);
	});

	it('rejects every existing top-level route directory, so a declared path cannot shadow or extend a real route', () => {
		for (const dir of ROUTE_DIRS.filter((d) => /^[a-z]/.test(d))) {
			expect(problems([c(`/${dir}/`)]).length, dir).toBeGreaterThan(0);
			expect(problems([c(`/${dir}/extra/`)]).join(), `${dir}/extra`).toMatch(/reserved or existing route prefix/);
		}
	});

	it('rejects duplicate paths and duplicate pageKeys', () => {
		expect(problems([c('/a/b/', 'x'), c('/a/b/', 'y')]).join()).toMatch(/declared twice/);
		expect(problems([c('/a/b/', 'x'), c('/c/d/', 'x')]).join()).toMatch(/pageKey x is declared twice/);
	});

	it('is case-sensitive about duplicates (a differently cased path is simply invalid)', () => {
		expect(problems([c('/a/b/', 'x'), c('/A/b/', 'y')]).length).toBeGreaterThan(0);
	});

	it('rejects a bad pageKey', () => {
		expect(problems([c('/a/b/', 'Bad Key')]).join()).toMatch(/pageKey/);
	});

	it('rejects a `pages` key that is not a built-in static page', () => {
		expect(checkContentPaths({ pages: { '/about/': {}, '/shop/': {}, '/blog/': {} } }, ROUTE_DIRS)).toEqual([]);
		for (const bad of ['/checkout/', '/products/x/', '/about', '/nope/', '/shop/x/']) {
			expect(checkContentPaths({ pages: { [bad]: {} } }, ROUTE_DIRS).join(), bad).toMatch(/not a built-in static page/);
		}
	});
});

describe('matchDeclaredPath', () => {
	const declared = [c('/our/story/', 'story'), c('/care/guide/', 'care')];

	it('matches an exact declared path', () => {
		expect(matchDeclaredPath(declared, '/our/story/')?.pageKey).toBe('story');
		expect(matchDeclaredPath(declared, '/care/guide/')?.pageKey).toBe('care');
	});

	it('never matches a prefix, an extra segment, a missing slash, a different case, or an undeclared path', () => {
		for (const p of ['/our/story/extra/', '/our/story', '/Our/Story/', '/care/', '/care/guide', '/no-such-page/', '/a/b/', '/', '/our/story//', '/OUR/STORY/', '/our/story/%2e%2e/']) {
			expect(matchDeclaredPath(declared, p), p).toBeNull();
		}
	});

	it('an empty declaration matches nothing', () => {
		expect(matchDeclaredPath([], '/our/story/')).toBeNull();
	});
});


describe('contentViewPaths selection', () => {
	const content = [c('/reviews/', 'reviews'), c('/our/story/', 'story')];
	it('keeps every existing mount when absent & selects exact paths when present', () => {
		for (const path of [...BUILT_IN_CONTENT_PATHS, ...content.map((c) => c.path)]) expect(selectsContentView(undefined, path)).toBe(true);
		expect(selectsContentView(['/reviews/'], '/reviews/')).toBe(true);
		for (const path of [...BUILT_IN_CONTENT_PATHS, '/reviews', '/Reviews/', '/reviews/extra/', '/our/story/']) expect(selectsContentView(['/reviews/'], path), path).toBe(false);
		expect(selectsContentView([], '/about/')).toBe(false);
	});
	it('accepts scoped declared paths & the five supported static paths', () => {
		expect(checkContentPaths({ content, contentViewPaths: [...BUILT_IN_CONTENT_PATHS, '/reviews/', '/our/story/'] }, ROUTE_DIRS)).toEqual([]);
		expect(checkContentPaths({ content: [c('/reviews/', 'reviews')], contentViewPaths: ['/reviews/'] }, ROUTE_DIRS)).toEqual([]);
	});
	it('rejects duplicates, unknown/reserved paths & declarations omitted from selection', () => {
		expect(checkContentPaths({ contentViewPaths: ['/about/', '/about/'] }, ROUTE_DIRS).join()).toMatch(/twice/);
		for (const path of ['/api/', '/shop/', '/blog/', '/contact/', '/', '/unknown/', '/about', '/About/', '/reviews/*']) {
			expect(checkContentPaths({ contentViewPaths: [path] }, ROUTE_DIRS).join(), path).toMatch(/not a declared content path/);
		}
		expect(checkContentPaths({ content, contentViewPaths: ['/reviews/'] }, ROUTE_DIRS).join()).toMatch(/our\/story.*omitted/);
	});
});
