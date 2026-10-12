// Brand views, plan §2.3/§2.5: the pure construction of the blog view props, shared by the mounts and unit-tested directly.
import { buildBlogBody } from '~/platform/blog-content';
import { projectBlogCard, seal } from './project';
import type { BlogListViewProps, BlogPostViewProps, PublicIdentity } from '~/platform/views';
import type { BlogPostFull, BlogPostSummary } from '~/providers/shop/blog/blog';

/** The blog list page size: routes.json `blog.pageSize` (1-100; the API caps `take` at 100), else today's 20. */
export const blogPageSize = (routes: { blog?: { pageSize?: number } } | null | undefined): number => routes?.blog?.pageSize ?? 20;

/** `posts` carry `readingTime` and the date fallback; `hasMore` is true when the total exceeds the listed page (no crawlable link past it). */
export function buildBlogListView(identity: PublicIdentity, items: readonly BlogPostSummary[], total: number, pageSize: number): BlogListViewProps {
	const posts = items.map(projectBlogCard);
	return seal<BlogListViewProps>({ identity, posts, total, pageSize, hasMore: total > posts.length }) as BlogListViewProps;
}

/** `missing` for a null post (the loader already set the 404 status), else `found` with the body, the TOC checked against it, and related posts. */
export function buildBlogPostView(identity: PublicIdentity, post: BlogPostFull | null, related: readonly BlogPostSummary[]): BlogPostViewProps {
	if (!post) return seal<BlogPostViewProps>({ identity, state: 'missing' }) as BlogPostViewProps;
	const { body, toc } = buildBlogBody(post.bodyHtml || '');
	const card = projectBlogCard(post);
	return seal<BlogPostViewProps>({
		identity,
		state: 'found',
		post: {
			slug: post.slug,
			title: post.title,
			excerpt: post.excerpt || null,
			publishedAt: card.publishedAt,
			authorName: post.authorName || null,
			image: card.image,
			tags: card.tags,
			readingTime: card.readingTime,
			toc,
			body,
		},
		related: related.map(projectBlogCard),
	}) as BlogPostViewProps;
}
