// Retired blog slugs that still collect search impressions -> their live successors (301). Ported from the previous the previous platform store
// (routes/blog/[slug]/index.tsx RENAMED_POSTS); the migration dropped them and /blog/knife-carry-laws-by-state/ became a 404.
const RENAMED_POSTS: Readonly<Record<string, string>> = {
	'knife-carry-laws-by-state': 'knife-carry-laws-by-state-2026',
	'd2-vs-14c28n-s35vn': 'd2-vs-14c28n-vs-s35vn',
	'best-edc-knives-under-100-in-2026': 'best-edc-knives-under-100',
	'why-we-chose-14c28n-steel-for-edc': 'why-we-chose-14c28n',
	// Consolidated 2026-09-28 (owner-approved): duplicated the lock comparison and lost its rankings.
	'knife-lock-types-explained': 'knife-lock-types-comparison',
};

/** The path a renamed post now lives at (`/blog/<new-slug>/`), or null when the slug was not renamed. */
export function renamedBlogPath(slug: string | undefined): string | null {
	if (!slug || !Object.prototype.hasOwnProperty.call(RENAMED_POSTS, slug)) return null;
	return `/blog/${RENAMED_POSTS[slug]}/`;
}
