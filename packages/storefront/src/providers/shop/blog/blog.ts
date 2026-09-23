import { srAssetUrl, srBlogPost, srBlogPosts, srErrorStatus, type SrBlogPost } from '~/utils/sellright';

export interface BlogPostSummary {
    id: string;
    title: string;
    slug: string;
    excerpt: string;
    readingTime: number;
    authorName: string;
    featuredAsset: { id: string; preview: string } | null;
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

function adaptPost(post: SrBlogPost): BlogPostSummary {
    return {
        ...post,
        excerpt: post.excerpt ?? '',
        readingTime: post.readingTime ?? 1,
        authorName: post.authorName ?? '',
        tags: post.tags ?? [],
        featuredAsset: post.featuredAsset ? { id: post.featuredAsset.id, preview: srAssetUrl(post.featuredAsset.path) } : null,
        // SellRight does not store creation timestamps; do not invent one.
        createdAt: null,
    };
}

export const getBlogPosts = async (take = 20, skip = 0): Promise<{ items: BlogPostSummary[]; totalItems: number }> => {
    const result = await srBlogPosts(take, skip);
    return { items: result.items.map(adaptPost), totalItems: result.totalItems };
};

export const getBlogPostBySlug = async (slug: string): Promise<BlogPostFull | null> => {
    try {
        const post = await srBlogPost(slug);
        return { ...adaptPost(post), bodyHtml: post.bodyHtml ?? '', isPublished: true, updatedAt: null, seoTitle: post.seoTitle ?? '', seoDescription: post.seoDescription ?? '' };
    } catch (error) {
        if (srErrorStatus(error) === 404) return null;
        throw error;
    }
};
