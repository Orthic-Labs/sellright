import { srAssetUrl, srBlogPost, srBlogPosts, srErrorStatus, type SrBlogPost } from '~/utils/sellright';

export interface BlogPostSummary {
    id: string;
    title: string;
    slug: string;
    excerpt: string;
    readingTime: number;
    authorName: string;
    featuredImage: { id: string; preview: string } | null;
    tags: string[];
    publishDate: string | null;
    createdAt: string | null;
}

export interface BlogPostFull extends BlogPostSummary {
    bodyHtml: string;
    isPublished: boolean;
    updatedAt: string | null;
    seoTitle: string;
    seoDescription: string;
}

// The shop API returns createdAt/updatedAt as ISO strings (shop-extra.ts); SrBlogPost in
// utils/sellright.ts does not declare them yet, so widen locally.
type SrBlogPostDated = SrBlogPost & { createdAt?: string | null; updatedAt?: string | null };

const isoOrNull = (v: string | null | undefined): string | null => (v ? v : null);

function adaptPost(post: SrBlogPostDated): BlogPostSummary {
    return {
        ...post,
        excerpt: post.excerpt ?? '',
        readingTime: post.readingTime ?? 1,
        authorName: post.authorName ?? '',
        tags: post.tags ?? [],
        featuredImage: post.featuredImage ? { id: post.featuredImage.id, preview: srAssetUrl(post.featuredImage.path) } : null,
        createdAt: isoOrNull(post.createdAt),
    };
}

export const getBlogPosts = async (take = 20, skip = 0): Promise<{ items: BlogPostSummary[]; totalItems: number }> => {
    const result = await srBlogPosts(take, skip);
    return { items: result.items.map(adaptPost), totalItems: result.totalItems };
};

export const getBlogPostBySlug = async (slug: string): Promise<BlogPostFull | null> => {
    try {
        const post = await srBlogPost(slug);
        return { ...adaptPost(post), bodyHtml: post.bodyHtml ?? '', isPublished: true, updatedAt: isoOrNull((post as SrBlogPostDated).updatedAt), seoTitle: post.seoTitle ?? '', seoDescription: post.seoDescription ?? '' };
    } catch (error) {
        if (srErrorStatus(error) === 404) return null;
        throw error;
    }
};
