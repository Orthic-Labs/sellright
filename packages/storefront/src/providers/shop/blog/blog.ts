const SHOP_API = 'http://localhost:3100/shop-api';

async function shopQuery<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const res = await fetch(SHOP_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors && !json.data) throw new Error(json.errors[0].message);
    return json.data;
}

const LIST_QUERY = `
    query GetPublishedBlogPosts($options: BlogPostListOptions) {
        blogPosts(options: $options) {
            items {
                id title slug excerpt readingTime authorName
                featuredAsset { id preview }
                tags publishDate createdAt
            }
            totalItems
        }
    }
`;

const POST_QUERY = `
    query GetBlogPostBySlug($slug: String!) {
        blogPost(slug: $slug) {
            id title slug excerpt bodyHtml readingTime authorName
            featuredAsset { id preview }
            tags isPublished publishDate createdAt updatedAt
            seoTitle seoDescription
        }
    }
`;

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
    createdAt: string;
}

export interface BlogPostFull extends BlogPostSummary {
    bodyHtml: string;
    isPublished: boolean;
    updatedAt: string;
    seoTitle: string;
    seoDescription: string;
}

export const getBlogPosts = async (take = 20, skip = 0): Promise<{ items: BlogPostSummary[]; totalItems: number }> => {
    try {
        const data = await shopQuery<{ blogPosts: { items: BlogPostSummary[]; totalItems: number } }>(LIST_QUERY, { options: { take, skip } });
        return data.blogPosts;
    } catch (error) {
        console.error('Failed to fetch blog posts:', error);
        return { items: [], totalItems: 0 };
    }
};

export const getBlogPostBySlug = async (slug: string): Promise<BlogPostFull | null> => {
    try {
        const data = await shopQuery<{ blogPost: BlogPostFull | null }>(POST_QUERY, { slug });
        return data.blogPost;
    } catch (error) {
        console.error(`Failed to fetch blog post "${slug}":`, error);
        return null;
    }
};
