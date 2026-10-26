import { beforeEach, describe, expect, it, vi } from 'vitest';

const sr = vi.hoisted(() => ({
	srBlogPosts: vi.fn(),
	srBlogPost: vi.fn(),
}));

vi.mock('~/utils/sellright', () => ({
	srAssetUrl: (path: string) => `/assets/${path}`,
	srBlogPosts: sr.srBlogPosts,
	srBlogPost: sr.srBlogPost,
	srErrorStatus: (e: { status?: number }) => e?.status,
}));

import { getBlogPostBySlug, getBlogPosts } from './blog';

const base = {
	id: 'p1', title: 'T', slug: 't', excerpt: null, readingTime: null, authorName: null, featuredImage: null, tags: null, publishDate: null,
};

describe('providers/shop/blog/blog', () => {
	beforeEach(() => {
		sr.srBlogPosts.mockReset();
		sr.srBlogPost.mockReset();
	});

	it('passes the API createdAt through on list items (no hardcoded null)', async () => {
		sr.srBlogPosts.mockResolvedValue({ items: [{ ...base, createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T00:00:00.000Z' }], totalItems: 1 });
		const { items } = await getBlogPosts();
		expect(items[0]!.createdAt).toBe('2026-01-02T03:04:05.000Z');
		expect(items[0]!.authorName).toBe('');
		expect(items[0]!.tags).toEqual([]);
	});

	it('passes createdAt and updatedAt through on the post detail', async () => {
		sr.srBlogPost.mockResolvedValue({ ...base, bodyHtml: '<p>x</p>', seoTitle: null, seoDescription: null, createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T00:00:00.000Z' });
		const post = await getBlogPostBySlug('t');
		expect(post).toMatchObject({ createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T00:00:00.000Z', bodyHtml: '<p>x</p>', isPublished: true });
	});

	it('falls back to null when the API omits the timestamps, and maps 404 to null', async () => {
		sr.srBlogPost.mockResolvedValue({ ...base, bodyHtml: null, seoTitle: null, seoDescription: null });
		expect(await getBlogPostBySlug('t')).toMatchObject({ createdAt: null, updatedAt: null });
		sr.srBlogPost.mockRejectedValue({ status: 404 });
		expect(await getBlogPostBySlug('missing')).toBeNull();
	});
});
