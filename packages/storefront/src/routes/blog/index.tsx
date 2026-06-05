import { component$, useStyles$ } from '@qwik.dev/core';
import { routeLoader$, Link } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { getBlogPosts } from '~/providers/shop/blog/blog';
import type { BlogPostSummary } from '~/providers/shop/blog/blog';

export const useBlogPosts = routeLoader$(async () => {
    return getBlogPosts(20, 0);
});

const STYLES = `
    .dd-blog { min-height: calc(100vh - 120px); background: #F7F2EA; padding: 4rem 1.5rem 6rem; }
    .dd-blog__inner { max-width: 780px; margin: 0 auto; }
    .dd-blog__header { margin-bottom: 3.5rem; }
    .dd-blog__badge { display: inline-flex; align-items: center; gap: 0.5rem; font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 400; letter-spacing: 0.12em; text-transform: uppercase; color: #B87333; margin-bottom: 1rem; }
    .dd-blog__badge::before, .dd-blog__badge::after { content: ''; display: inline-block; width: 20px; height: 1px; background: #c49a5a; }
    .dd-blog__title { font-family: 'Cormorant Garamond', serif; font-size: clamp(2rem, 4vw, 3rem); font-weight: 700; color: #111110; margin: 0 0 0.75rem; letter-spacing: -0.02em; line-height: 1.05; }
    .dd-blog__subtitle { font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 15px; color: #6B6560; line-height: 1.7; margin: 0; }
    .dd-blog__divider { border: none; border-top: 1px solid #ddd8d0; margin: 0 0 3rem; }
    .dd-blog__grid { display: flex; flex-direction: column; }
    .dd-blog-card { display: block; padding: 2rem 0 2rem 1.5rem; border-left: 2px solid transparent; text-decoration: none; color: inherit; transition: border-color 0.2s ease; }
    .dd-blog-card + .dd-blog-card { border-top: 1px solid #ece8e2; }
    .dd-blog-card:hover { border-left-color: #B87333; }
    .dd-blog-card__meta { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #9d8f84; margin-bottom: 0.6rem; display: flex; gap: 0.75rem; align-items: center; letter-spacing: 0.04em; }
    .dd-blog-card__meta-dot { display: inline-block; width: 3px; height: 3px; border-radius: 50%; background: #c49a5a; }
    .dd-blog-card__title { font-family: 'Cormorant Garamond', serif; font-size: clamp(1.25rem, 2.5vw, 1.6rem); font-weight: 700; color: #111110; margin: 0 0 0.6rem; letter-spacing: -0.02em; line-height: 1.1; }
    .dd-blog-card:hover .dd-blog-card__title { color: #B87333; }
    .dd-blog-card__excerpt { font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 14px; color: #6B6560; line-height: 1.65; margin: 0; max-width: 60ch; }
    .dd-blog__cta { text-align: center; margin-top: 4rem; padding: 3rem 1.5rem; background: rgba(184,115,51,0.06); border-radius: 12px; }
    .dd-blog__cta-title { font-family: 'Cormorant Garamond', serif; font-size: 1.25rem; font-weight: 700; color: #111110; margin: 0 0 0.5rem; }
    .dd-blog__cta-text { font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 14px; color: #6B6560; margin: 0 0 1.25rem; }
    .dd-blog__cta-link { display: inline-block; padding: 10px 24px; background: #B87333; color: #fff; border-radius: 6px; text-decoration: none; font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 14px; font-weight: 500; transition: background 0.2s; }
    .dd-blog__cta-link:hover { background: #a06a2d; }
    .dd-blog__empty { text-align: center; padding: 4rem 1rem; }
    .dd-blog__empty-text { font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 15px; color: #6B6560; line-height: 1.7; }
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
        <div class="dd-blog">
            <div class="dd-blog__inner">
                <div class="dd-blog__header">
                    <div class="dd-blog__badge">From the Bench</div>
                    <h1 class="dd-blog__title">Steel, Craft & Carry</h1>
                    <p class="dd-blog__subtitle">Stories about knives, materials, and the decisions behind how we build.</p>
                </div>
                <hr class="dd-blog__divider" />

                {posts.length === 0 ? (
                    <div class="dd-blog__empty">
                        <p class="dd-blog__empty-text">Stories are coming. Sign up for our newsletter to be the first to know.</p>
                    </div>
                ) : (
                    <div class="dd-blog__grid">
                        {posts.map((post: BlogPostSummary) => (
                            <Link key={post.id} href={`/blog/${post.slug}/`} class="dd-blog-card">
                                <div class="dd-blog-card__meta">
                                    <span>{fmtDate(post.publishDate || post.createdAt)}</span>
                                    <span class="dd-blog-card__meta-dot" />
                                    <span>{post.readingTime} min read</span>
                                </div>
                                <h2 class="dd-blog-card__title">{post.title}</h2>
                                <p class="dd-blog-card__excerpt">{post.excerpt}</p>
                            </Link>
                        ))}
                    </div>
                )}

                <div class="dd-blog__cta">
                    <h3 class="dd-blog__cta-title">See the blades</h3>
                    <p class="dd-blog__cta-text">Every piece is made to be used. Browse the full collection.</p>
                    <Link href="/shop/" class="dd-blog__cta-link">Shop the Collection</Link>
                </div>
            </div>
        </div>
    );
});

export const head = ({ resolveValue }: any) => {
    const blogData = resolveValue(useBlogPosts);
    const isEmpty = blogData.totalItems === 0;

    return createSEOHead({
        title: 'From the Bench — Damned Designs Journal',
        description: 'Stories about steel, craft, and the making of knives from Damned Designs.',
        ogUrl: 'https://www.damneddesigns.com/blog/',
        canonical: 'https://www.damneddesigns.com/blog/',
        noindex: isEmpty,
        schemas: [
            {
                '@context': 'https://schema.org',
                '@type': 'Blog',
                name: 'Damned Designs Journal',
                description: 'Stories about steel, craft, and the making of knives.',
                url: 'https://www.damneddesigns.com/blog/',
                publisher: { '@type': 'Organization', name: 'Damned Designs', url: 'https://www.damneddesigns.com' },
            },
            {
                '@context': 'https://schema.org',
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.damneddesigns.com/' },
                    { '@type': 'ListItem', position: 2, name: 'Journal', item: 'https://www.damneddesigns.com/blog/' },
                ],
            },
        ],
    });
};
