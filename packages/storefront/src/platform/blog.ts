// A13: blog index platform code moved verbatim from src/routes/blog/index.tsx (loader + SEO head).
import { routeLoader$ } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { getBlogPosts } from '~/providers/shop/blog/blog';
import { theme, siteUrl } from '~/theme/theme.config';

export const useBlogPosts = routeLoader$(async () => {
    return getBlogPosts(20, 0);
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
