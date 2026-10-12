// A13: blog index platform code moved verbatim from src/routes/blog/index.tsx (loader + SEO head).
import { routeLoader$ } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { getBlogPostBySlug, getBlogPosts, type BlogPostSummary } from '~/providers/shop/blog/blog';
import { theme, siteUrl } from '~/theme/theme.config';
import { BRAND_ROUTES } from '~/platform/brand-data';
import { fixBodyHtml, rankRelatedPosts, RELATED_POOL } from '~/platform/blog-content';
import { hasView } from '~/platform/gateway';
import { blogPageSize } from '~/platform/controllers/blog-view';

/** The blog list page size: routes.json `blog.pageSize` (1-100; the API caps `take` at 100), else today's 20. */
export const BLOG_PAGE_SIZE: number = blogPageSize(BRAND_ROUTES);

export const useBlogPosts = routeLoader$(async () => {
    return getBlogPosts(BLOG_PAGE_SIZE, 0);
});

// Moved verbatim from routes/blog/[slug]/index.tsx (the route re-exports them, the A13 pattern).
export const useBlogPost = routeLoader$(async (requestEvent) => {
    const slug = requestEvent.params.slug;
    const post = await getBlogPostBySlug(slug);
    if (!post) { requestEvent.status(404); return null; }
    if (post.bodyHtml) post.bodyHtml = fixBodyHtml(post.bodyHtml);
    return post;
});

export const useRelatedPosts = routeLoader$(async (requestEvent) => {
    const slug = requestEvent.params.slug;
    try {
        if (hasView('route.blog-post')) {
            // A `route.blog-post` view: related = shared tags, then recency, then slug over the latest posts, fetched per request.
            const current = await requestEvent.resolveValue(useBlogPost);
            const { items } = await getBlogPosts(RELATED_POOL, 0);
            return rankRelatedPosts({ slug, tags: current?.tags ?? [] }, items.map((p) => ({ ...p, publishedAt: p.publishDate || p.createdAt })), 3).map(({ publishedAt: _drop, ...p }) => p) as BlogPostSummary[];
        }
        const { items } = await getBlogPosts(6, 0);
        return items.filter((p) => p.slug !== slug).slice(0, 3);
    } catch {
        return [] as BlogPostSummary[];
    }
});

export const head = ({ resolveValue }: any) => {
    const blogData = resolveValue(useBlogPosts);
    const isEmpty = blogData.totalItems === 0;

    return createSEOHead({
        title: `Journal — ${theme.storeName}`,
        description: `Stories and updates from ${theme.storeName}.`,
        ogUrl: `${siteUrl}/blog/`,
        canonical: `${siteUrl}/blog/`,
        noindex: isEmpty,
        schemas: [
            {
                '@context': 'https://schema.org',
                '@type': 'Blog',
                name: `${theme.storeName} Journal`,
                description: `Stories and updates from ${theme.storeName}.`,
                url: `${siteUrl}/blog/`,
                publisher: { '@type': 'Organization', name: theme.storeName, url: siteUrl },
            },
            {
                '@context': 'https://schema.org',
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
                    { '@type': 'ListItem', position: 2, name: 'Journal', item: `${siteUrl}/blog/` },
                ],
            },
        ],
    });
};
