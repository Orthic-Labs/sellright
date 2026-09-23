import { component$, useStyles$ } from '@qwik.dev/core';
import { OptimizedImage } from '~/components/ui/LazyImage';
import { routeLoader$, Link } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { sanitizeHtml, stripHtml } from '~/utils/sanitize';
import { getBlogPostBySlug, getBlogPosts } from '~/providers/shop/blog/blog';
import type { BlogPostFull, BlogPostSummary } from '~/providers/shop/blog/blog';
import { theme, siteUrl } from '~/theme/theme.config';

function fixBodyHtml(html: string): string {
    return html
        // <p>---</p> → <hr>
        .replace(/<p>\s*-{3,}\s*<\/p>/g, '<hr>')
        // <p>## Heading</p> → <h2>Heading</h2>
        .replace(/<p>\s*#{6}\s+(.+?)<\/p>/g, '<h6>$1</h6>')
        .replace(/<p>\s*#{5}\s+(.+?)<\/p>/g, '<h5>$1</h5>')
        .replace(/<p>\s*#{4}\s+(.+?)<\/p>/g, '<h4>$1</h4>')
        .replace(/<p>\s*#{3}\s+(.+?)<\/p>/g, '<h3>$1</h3>')
        .replace(/<p>\s*#{2}\s+(.+?)<\/p>/g, '<h2>$1</h2>')
        .replace(/<p>\s*#{1}\s+(.+?)<\/p>/g, '<h1>$1</h1>');
}

// stripHtml (DOMPurify, real HTML parser) instead of the previous hand-rolled
// implementation: a single-pass `/<[^>]+>/g` tag-strip can leave a
// reconstructed `<script` behind for crafted input like `<scr<script>ipt>`
// (CodeQL js/incomplete-multi-character-sanitization), and chaining entity
// decodes (`&amp;` → `&` before `&lt;`/`&gt;` → `<`/`>`) on the same string can
// double-unescape a legitimately double-encoded value, e.g. `&amp;lt;` — which
// should stay literal text `&lt;` — instead reconstructing `<` (CodeQL
// js/double-escaping). A real HTML parser decodes entities exactly once, in
// the correct DOM-text-node semantics, with no hand-written regex chain.
function stripTags(s: string): string {
    return stripHtml(s).replace(/\s+/g, ' ').trim();
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// Inject stable ids onto every <h2> and collect a table of contents.
function addHeadingIdsAndToc(html: string): { html: string; toc: { id: string; text: string }[] } {
    const toc: { id: string; text: string }[] = [];
    const used = new Set<string>();
    const out = html.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/gi, (_m, attrs, inner) => {
        const text = stripTags(inner);
        const base = slugify(text);
        if (!base) return `<h2${attrs || ''}>${inner}</h2>`;
        let id = base, i = 2;
        while (used.has(id)) id = `${base}-${i++}`;
        used.add(id);
        toc.push({ id, text });
        return `<h2 id="${id}"${attrs || ''}>${inner}</h2>`;
    });
    return { html: out, toc };
}

// Heuristically derive FAQ Q&A pairs from the body so we can emit FAQPage schema.
// Looks for an <h2> labelled FAQ / "frequently asked", then pairs each following
// <h3>/<h4> question with its answer text. Returns [] if fewer than 2 clean pairs.
function extractFaq(html: string): { q: string; a: string }[] {
    try {
        const sections = html.split(/(?=<h2[\s>])/i);
        let faq = '';
        for (const sec of sections) {
            const h = sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
            if (h && /faq|frequently asked|common questions/i.test(stripTags(h[1]))) { faq = sec; break; }
        }
        if (!faq) return [];
        // Question markers: <h3>/<h4> headings OR <p><strong>Question?</strong></p>
        const body = faq.replace(/^[\s\S]*?<\/h2>/i, '');
        const qRe = /<h[34][^>]*>([\s\S]*?)<\/h[34]>|<p>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>/gi;
        const marks: { q: string; start: number; end: number }[] = [];
        let m: RegExpExecArray | null;
        while ((m = qRe.exec(body)) !== null) {
            const q = stripTags(m[1] || m[2] || '');
            if (q) marks.push({ q, start: m.index, end: m.index + m[0].length });
        }
        const pairs: { q: string; a: string }[] = [];
        for (let i = 0; i < marks.length; i++) {
            const a = stripTags(body.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : body.length));
            if (marks[i].q && a.length > 10) pairs.push({ q: marks[i].q, a });
        }
        return pairs.length >= 2 ? pairs : [];
    } catch {
        return [];
    }
}

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
        const { items } = await getBlogPosts(6, 0);
        return items.filter((p) => p.slug !== slug).slice(0, 3);
    } catch {
        return [] as BlogPostSummary[];
    }
});

const STYLES = `
    .sr-post { min-height: calc(100vh - 120px); background: var(--color-parchment); padding: 3rem 1.5rem 6rem; }
    .sr-post__inner { max-width: 860px; margin: 0 auto; }
    .sr-post__back { display: inline-flex; align-items: center; gap: 0.375rem; font-family: var(--font-body); font-size: 13px; font-weight: 500; color: var(--color-accent); text-decoration: none; margin-bottom: 1.25rem; transition: color 0.2s; }
    .sr-post__back:hover { color: #a06a2d; }
    .sr-post__crumbs { font-family: var(--font-mono); font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1.25rem; }
    .sr-post__crumbs a { color: #94a3b8; text-decoration: none; }
    .sr-post__crumbs a:hover { color: var(--color-accent); }
    .sr-post__meta { font-family: var(--font-mono); font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; display: flex; gap: 0.75rem; align-items: center; }
    .sr-post__title { font-family: var(--font-display); font-size: clamp(1.75rem, 4vw, 2.5rem); font-weight: 700; color: var(--color-ink); margin: 0 0 1rem; letter-spacing: -0.02em; line-height: 1.1; }
    .sr-post__author { font-family: var(--font-body); font-size: 14px; color: #6B6560; margin-bottom: 1.5rem; }
    .sr-post__tags { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 2rem; }
    .sr-post__tag { font-family: var(--font-mono); font-size: 12px; color: var(--color-accent); background: rgba(var(--color-accent-rgb),0.08); padding: 3px 10px; border-radius: 12px; }
    .sr-post__hero { width: 100%; border-radius: 10px; margin-bottom: 2.5rem; aspect-ratio: 16/9; object-fit: cover; display: block; }
    .sr-post__toc { background: #fff; border: 1px solid #e7ded1; border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 2.5rem; }
    .sr-post__toc-title { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #6B6560; margin: 0 0 0.75rem; }
    .sr-post__toc ol { margin: 0; padding-left: 1.1rem; }
    .sr-post__toc li { margin-bottom: 0.35rem; }
    .sr-post__toc a { font-family: var(--font-body); font-size: 14px; color: var(--color-accent); text-decoration: none; }
    .sr-post__toc a:hover { text-decoration: underline; }
    .sr-post__body { font-family: var(--font-body); font-size: 16px; line-height: 1.8; color: #2d2a26; }
    .sr-post__body h2 { font-family: var(--font-display); font-size: 1.5em; font-weight: 700; margin: 2em 0 0.75em; letter-spacing: -0.01em; color: var(--color-ink); scroll-margin-top: 90px; }
    .sr-post__body h3 { font-family: var(--font-display); font-size: 1.25em; font-weight: 700; margin: 1.5em 0 0.5em; color: var(--color-ink); }
    .sr-post__body p { margin: 0 0 1em; }
    .sr-post__body img { max-width: 100%; height: auto; border-radius: 8px; margin: 1.5em 0; }
    .sr-post__body a { color: var(--color-accent); text-decoration: underline; }
    .sr-post__body a:hover { color: #a06a2d; }
    .sr-post__body blockquote { border-left: 3px solid var(--color-accent); padding-left: 1.25em; margin: 1.5em 0; color: #6B6560; font-style: italic; }
    .sr-post__body ul, .sr-post__body ol { padding-left: 1.5em; margin: 0.75em 0; }
    .sr-post__body li { margin-bottom: 0.25em; }
    .sr-post__body hr { border: none; border-top: 1px solid #d4cdc4; margin: 2em 0; }
    .sr-post__404 { text-align: center; padding: 6rem 1rem; }
    .sr-post__404-title { font-family: var(--font-display); font-size: 2rem; font-weight: 700; color: var(--color-ink); margin: 0 0 1rem; }
    .sr-post__bio { display: flex; gap: 1rem; align-items: flex-start; margin-top: 3.5rem; padding: 1.5rem; background: #fff; border: 1px solid #e7ded1; border-radius: 10px; }
    .sr-post__bio-mark { flex: none; width: 44px; height: 44px; border-radius: 50%; background: var(--color-ink); color: var(--color-accent); display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-size: 22px; font-weight: 700; }
    .sr-post__bio-name { font-family: var(--font-body); font-weight: 700; font-size: 15px; color: var(--color-ink); margin: 0; }
    .sr-post__bio-role { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-accent); margin: 0.1rem 0 0.5rem; }
    .sr-post__bio-text { font-family: var(--font-body); font-size: 13.5px; line-height: 1.6; color: #6B6560; margin: 0; }
    .sr-post__related { margin-top: 3.5rem; padding-top: 2rem; border-top: 1px solid #d4cdc4; }
    .sr-post__related-title { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #6B6560; margin: 0 0 1rem; }
    .sr-post__related-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
    .sr-post__related-card { display: block; padding: 1rem; background: #fff; border: 1px solid #e7ded1; border-radius: 10px; text-decoration: none; transition: border-color 0.2s; }
    .sr-post__related-card:hover { border-color: var(--color-accent); }
    .sr-post__related-card h3 { font-family: var(--font-display); font-size: 1.1rem; font-weight: 700; color: var(--color-ink); margin: 0 0 0.35rem; line-height: 1.2; }
    .sr-post__related-card p { font-family: var(--font-body); font-size: 12.5px; color: #6B6560; margin: 0; }
    .sr-post__cta { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #d4cdc4; text-align: center; }
    .sr-post__cta-link { display: inline-block; padding: 10px 24px; background: var(--color-accent); color: #fff; border-radius: 6px; text-decoration: none; font-family: var(--font-body); font-size: 14px; font-weight: 500; transition: background 0.2s; margin-top: 1rem; }
    .sr-post__cta-link:hover { background: #a06a2d; }
    @media (max-width: 640px) { .sr-post__related-grid { grid-template-columns: 1fr; } }
`;

export default component$(() => {
    useStyles$(STYLES);
    const postSignal = useBlogPost();
    const related = useRelatedPosts();
    const post = postSignal.value as BlogPostFull | null;

    const fmtDate = (d: string | null) => {
        if (!d) return '';
        return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    };

    if (!post) {
        return (
            <div class="sr-post"><div class="sr-post__404">
                <h1 class="sr-post__404-title">Post Not Found</h1>
                <Link href="/blog/" class="sr-post__back">&larr; Back to Lore</Link>
            </div></div>
        );
    }

    const { html: bodyWithIds, toc } = addHeadingIdsAndToc(post.bodyHtml || '');

    return (
        <div class="sr-post">
            <div class="sr-post__inner">
                <nav class="sr-post__crumbs" aria-label="Breadcrumb">
                    <Link href="/">Home</Link> / <Link href="/blog/">Journal</Link> / <span aria-current="page">{post.title}</span>
                </nav>
                <Link href="/blog/" class="sr-post__back">&larr; Lore</Link>
                <div class="sr-post__meta">
                    <span>{fmtDate(post.publishDate || post.createdAt)}</span>
                    <span>{post.readingTime} min read</span>
                </div>
                <h1 class="sr-post__title">{post.title}</h1>
                {post.authorName && <p class="sr-post__author">By {post.authorName}</p>}
                {post.tags.length > 0 && (
                    <div class="sr-post__tags">
                        {post.tags.map((tag: string) => <span key={tag} class="sr-post__tag">{tag}</span>)}
                    </div>
                )}
                {post.featuredAsset && (
                    <OptimizedImage src={post.featuredAsset.preview} alt={post.title} class="sr-post__hero" width={1280} height={720} priority responsive="hero" />
                )}
                {toc.length >= 3 && (
                    <nav class="sr-post__toc" aria-label="In this guide">
                        <p class="sr-post__toc-title">In this guide</p>
                        <ol>
                            {toc.map((t) => <li key={t.id}><a href={`#${t.id}`}>{t.text}</a></li>)}
                        </ol>
                    </nav>
                )}
                <div class="sr-post__body" dangerouslySetInnerHTML={sanitizeHtml(bodyWithIds)} />

                <div class="sr-post__bio">
                    <span class="sr-post__bio-mark" aria-hidden="true">{(post.authorName || theme.storeName).charAt(0)}</span>
                    <div>
                        <p class="sr-post__bio-name">{post.authorName || theme.storeName}</p>
                        <p class="sr-post__bio-role">{theme.storeName} Team</p>
                    </div>
                </div>

                {related.value.length > 0 && (
                    <div class="sr-post__related">
                        <p class="sr-post__related-title">Continue reading</p>
                        <div class="sr-post__related-grid">
                            {related.value.map((r) => (
                                <Link key={r.id} href={`/blog/${r.slug}/`} class="sr-post__related-card">
                                    <h3>{r.title}</h3>
                                    <p>{r.excerpt}</p>
                                </Link>
                            ))}
                            <Link href="/shop/" class="sr-post__related-card">
                                <h3>Shop the Collection</h3>
                                <p>See the products behind the writing.</p>
                            </Link>
                        </div>
                    </div>
                )}

                <div class="sr-post__cta">
                    <p style={{ fontFamily: 'var(--font-body)', fontSize: '15px', color: '#6B6560', margin: 0 }}>
                        Browse the shop.
                    </p>
                    <Link href="/shop/" class="sr-post__cta-link">Shop the Collection</Link>
                </div>
            </div>
        </div>
    );
});

export const head = ({ resolveValue }: any) => {
    const post = resolveValue(useBlogPost) as BlogPostFull | null;
    if (!post) {
        return createSEOHead({
            title: `Post Not Found — ${theme.storeName}`,
            description: 'The requested blog post could not be found.',
            ogUrl: `${siteUrl}/blog/`,
            noindex: true,
        });
    }

    const seoTitle = post.seoTitle || post.title;
    const seoDesc = post.seoDescription || post.excerpt;
    const postUrl = `${siteUrl}/blog/${post.slug}/`;
    const rawImage = post.featuredAsset?.preview || '';
    const image = rawImage.startsWith('http') ? rawImage : rawImage ? `${siteUrl}${rawImage}` : `${siteUrl}${theme.ogImageUrl}`;

    const authorName = post.authorName || theme.storeName;
    const authorSchema = { '@type': 'Person' as const, name: authorName };

    const faq = extractFaq(post.bodyHtml || '');

    const schemas: any[] = [
        {
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: post.title,
            description: post.excerpt,
            url: postUrl,
            datePublished: post.publishDate || post.createdAt,
            dateModified: post.updatedAt,
            image: { '@type': 'ImageObject', url: image + (post.featuredAsset ? '?preset=xl' : ''), width: 1200, height: 630 },
            author: authorSchema,
            publisher: { '@type': 'Organization', '@id': `${siteUrl}/#organization`, name: theme.storeName, url: siteUrl, logo: { '@type': 'ImageObject', url: `${siteUrl}/logo.png` } },
            mainEntityOfPage: { '@type': 'WebPage', '@id': postUrl },
        },
        {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
                { '@type': 'ListItem', position: 2, name: 'Journal', item: `${siteUrl}/blog/` },
                { '@type': 'ListItem', position: 3, name: post.title, item: postUrl },
            ],
        },
    ];

    if (faq.length >= 2) {
        schemas.push({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: faq.map((f) => ({
                '@type': 'Question',
                name: f.q,
                acceptedAnswer: { '@type': 'Answer', text: f.a },
            })),
        });
    }

    return createSEOHead({
        title: seoTitle,
        description: seoDesc,
        ogUrl: postUrl,
        image,
        canonical: postUrl,
        ogType: 'article',
        articleMeta: {
            publishedTime: post.publishDate || post.createdAt,
            modifiedTime: post.updatedAt,
            section: post.tags?.[0] || 'Journal',
            tags: post.tags || [],
            author: authorName,
        },
        schemas,
    });
};
