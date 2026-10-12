// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blogPageSize, buildBlogListView, buildBlogPostView } from './blog-view';

const identity = { storeName: 'S', legalName: 'S', tagline: 't', supportEmail: 'a@b.c', logoText: 'S', logoImageUrl: null, siteOrigin: 'https://s.example', social: {} };
const summary = (slug: string, over: Record<string, unknown> = {}) => ({ id: slug, slug, title: `T ${slug}`, excerpt: 'E', readingTime: 3, authorName: 'A', featuredImage: null, tags: ['x'], publishDate: '2026-02-03', createdAt: null, ...over }) as never;
const full = (over: Record<string, unknown> = {}) => ({ ...(summary('p') as object), bodyHtml: '<h2>One</h2><p>a</p><h2>Two</h2>', isPublished: true, updatedAt: null, seoTitle: '', seoDescription: '', ...over }) as never;

describe('blog list view', () => {
	it('page size: pageSize 100 -> 100, absent -> 20 (today\'s call), and the loader uses it', () => {
		expect(blogPageSize({ blog: { pageSize: 100 } })).toBe(100);
		expect(blogPageSize({ blog: {} })).toBe(20);
		expect(blogPageSize({})).toBe(20);
		expect(blogPageSize(null)).toBe(20);
		const loader = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../blog.ts'), 'utf8');
		expect(loader).toContain('getBlogPosts(BLOG_PAGE_SIZE, 0)');
		expect(loader).toContain('blogPageSize(BRAND_ROUTES)');
	});

	it('cards carry readingTime and the date fallback; hasMore = total > listed', () => {
		const v = buildBlogListView(identity, [summary('a'), summary('b', { publishDate: null, createdAt: '2026-01-01', readingTime: 0 })], 2, 100);
		expect(v.posts.map((p) => [p.slug, p.readingTime, p.publishedAt])).toEqual([['a', 3, '2026-02-03'], ['b', 1, '2026-01-01']]);
		expect(v.hasMore).toBe(false);
		expect(v.pageSize).toBe(100);
		expect(buildBlogListView(identity, [summary('a')], 5, 1).hasMore).toBe(true);
		expect(buildBlogListView(identity, [], 0, 20)).toMatchObject({ posts: [], total: 0, hasMore: false });
	});

	it('the view data is frozen in test mode', () => {
		const v = buildBlogListView(identity, [summary('a')], 1, 20);
		expect(Object.isFrozen(v)).toBe(true);
		expect(() => { (v.posts as { slug: string }[])[0].slug = 'x'; }).toThrow(TypeError);
	});
});

describe('blog post view', () => {
	it('missing -> state missing (the loader keeps the 404 status), with no post data', () => {
		const v = buildBlogPostView(identity, null, [summary('r')]);
		expect(v).toEqual({ identity, state: 'missing' });
	});

	it('found -> sanitised body, a TOC that exists in the body, projected related cards', () => {
		const v = buildBlogPostView(identity, full(), [summary('r1'), summary('r2')]);
		if (v.state !== 'found') throw new Error('expected found');
		expect(v.post.body.kind).toBe('sanitized-html');
		expect(v.post.toc.map((t) => t.id)).toEqual(['one', 'two']);
		for (const t of v.post.toc) expect(v.post.body.html).toContain(`id="${t.id}"`);
		expect(v.related.map((r) => r.slug)).toEqual(['r1', 'r2']);
		expect(v.related[0].href).toBe('/blog/r1/');
		expect(v.post).toMatchObject({ slug: 'p', title: 'T p', excerpt: 'E', authorName: 'A', readingTime: 3, publishedAt: '2026-02-03' });
	});

	it('a script in the body never reaches the view', () => {
		const v = buildBlogPostView(identity, full({ bodyHtml: '<h2>One</h2><script>alert(1)</script><p onclick="x()">p</p>' }), []);
		if (v.state !== 'found') throw new Error('expected found');
		expect(v.post.body.html).not.toMatch(/script|onclick/);
	});
});
