import { component$, useStyles$ } from '@qwik.dev/core';
import { routeLoader$, Link } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { getBlogPosts } from '~/providers/shop/blog/blog';
import type { BlogPostSummary } from '~/providers/shop/blog/blog';
import { theme, siteUrl } from '~/theme/theme.config';

export const useBlogPosts = routeLoader$(async () => {
    return getBlogPosts(20, 0);
});

const STYLES = `
    .sr-blog { min-height: calc(100vh - 120px); background: var(--color-parchment); padding: 4rem 1.5rem 6rem; }
    .sr-blog__inner { max-width: 780px; margin: 0 auto; }
    .sr-blog__header { margin-bottom: 3.5rem; }
    .sr-blog__badge { display: inline-flex; align-items: center; gap: 0.5rem; font-family: var(--font-mono); font-size: 11px; font-weight: 400; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-accent); margin-bottom: 1rem; }
    .sr-blog__badge::before, .sr-blog__badge::after { content: ''; display: inline-block; width: 20px; height: 1px; background: #c49a5a; }
    .sr-blog__title { font-family: var(--font-display); font-size: clamp(2rem, 4vw, 3rem); font-weight: 700; color: var(--color-ink); margin: 0 0 0.75rem; letter-spacing: -0.02em; line-height: 1.05; }
    .sr-blog__subtitle { font-family: var(--font-body); font-size: 15px; color: #6B6560; line-height: 1.7; margin: 0; }
    .sr-blog__divider { border: none; border-top: 1px solid #ddd8d0; margin: 0 0 3rem; }
    .sr-blog__grid { display: flex; flex-direction: column; }
    .sr-blog-card { display: block; padding: 2rem 0 2rem 1.5rem; border-left: 2px solid transparent; text-decoration: none; color: inherit; transition: border-color 0.2s ease; }
    .sr-blog-card + .sr-blog-card { border-top: 1px solid #ece8e2; }
    .sr-blog-card:hover { border-left-color: var(--color-accent); }
    .sr-blog-card__meta { font-family: var(--font-mono); font-size: 11px; color: #9d8f84; margin-bottom: 0.6rem; display: flex; gap: 0.75rem; align-items: center; letter-spacing: 0.04em; }
    .sr-blog-card__meta-dot { display: inline-block; width: 3px; height: 3px; border-radius: 50%; background: #c49a5a; }
    .sr-blog-card__title { font-family: var(--font-display); font-size: clamp(1.25rem, 2.5vw, 1.6rem); font-weight: 700; color: var(--color-ink); margin: 0 0 0.6rem; letter-spacing: -0.02em; line-height: 1.1; }
    .sr-blog-card:hover .sr-blog-card__title { color: var(--color-accent); }
    .sr-blog-card__excerpt { font-family: var(--font-body); font-size: 14px; color: #6B6560; line-height: 1.65; margin: 0; max-width: 60ch; }
    .sr-blog__cta { text-align: center; margin-top: 4rem; padding: 3rem 1.5rem; background: rgba(var(--color-accent-rgb),0.06); border-radius: 12px; }
    .sr-blog__cta-title { font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; color: var(--color-ink); margin: 0 0 0.5rem; }
    .sr-blog__cta-text { font-family: var(--font-body); font-size: 14px; color: #6B6560; margin: 0 0 1.25rem; }
    .sr-blog__cta-link { display: inline-block; padding: 10px 24px; background: var(--color-accent); color: #fff; border-radius: 6px; text-decoration: none; font-family: var(--font-body); font-size: 14px; font-weight: 500; transition: background 0.2s; }
    .sr-blog__cta-link:hover { background: #a06a2d; }
    .sr-blog__empty { text-align: center; padding: 4rem 1rem; }
    .sr-blog__empty-text { font-family: var(--font-body); font-size: 15px; color: #6B6560; line-height: 1.7; }
`;

export default component$(() => {
    useStyles$(STYLES);
    const blogData = useBlogPosts();
    const posts = blogData.value.items;

    const fmtDate = (d: string | null) => {
        if (!d) return '';
        return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    };

    return (
        <div class="sr-blog">
            <div class="sr-blog__inner">
                <div class="sr-blog__header">
                    <div class="sr-blog__badge">Journal</div>
                    <h1 class="sr-blog__title">Stories &amp; updates</h1>
                    <p class="sr-blog__subtitle">Notes on products, materials, and the decisions behind how we build.</p>
                </div>
                <hr class="sr-blog__divider" />

                {posts.length === 0 ? (
                    <div class="sr-blog__empty">
                        <p class="sr-blog__empty-text">Stories are coming. Sign up for our newsletter to be the first to know.</p>
                    </div>
                ) : (
                    <div class="sr-blog__grid">
                        {posts.map((post: BlogPostSummary) => (
                            <Link key={post.id} href={`/blog/${post.slug}/`} class="sr-blog-card">
                                <div class="sr-blog-card__meta">
                                    <span>{fmtDate(post.publishDate || post.createdAt)}</span>
                                    <span class="sr-blog-card__meta-dot" />
                                    <span>{post.readingTime} min read</span>
                                </div>
                                <h2 class="sr-blog-card__title">{post.title}</h2>
                                <p class="sr-blog-card__excerpt">{post.excerpt}</p>
                            </Link>
                        ))}
                    </div>
                )}

                <div class="sr-blog__cta">
                    <h3 class="sr-blog__cta-title">Browse the shop</h3>
                    <p class="sr-blog__cta-text">Every piece is made to be used. Browse the full collection.</p>
                    <Link href="/shop/" class="sr-blog__cta-link">Shop the Collection</Link>
                </div>
            </div>
        </div>
    );
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
