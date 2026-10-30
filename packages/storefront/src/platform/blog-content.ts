// Brand views, plan §2.5: the blog body pipeline and related-post ranking, moved out of routes/blog/[slug]/index.tsx so the base
// page and the brand view share one implementation. Pure (no Qwik); unit tests import it directly.
import { stripHtml } from '~/utils/sanitize';
import { toSanitizedHtml, type SanitizedHtml } from '~/platform/sanitized';

/**
 * #408 item 4: the post title is the page's only <h1>. Markdown `# ` paragraphs and any authored <h1> in the body render as
 * <h2> (attributes kept), site-wide: base page and brand views both read the body through useBlogPost.
 */
export function fixBodyHtml(html: string): string {
	return demoteBodyH1(html
		// <p>---</p> → <hr>
		.replace(/<p>\s*-{3,}\s*<\/p>/g, '<hr>')
		// <p>## Heading</p> → <h2>Heading</h2>
		.replace(/<p>\s*#{6}\s+(.+?)<\/p>/g, '<h6>$1</h6>')
		.replace(/<p>\s*#{5}\s+(.+?)<\/p>/g, '<h5>$1</h5>')
		.replace(/<p>\s*#{4}\s+(.+?)<\/p>/g, '<h4>$1</h4>')
		.replace(/<p>\s*#{3}\s+(.+?)<\/p>/g, '<h3>$1</h3>')
		.replace(/<p>\s*#{2}\s+(.+?)<\/p>/g, '<h2>$1</h2>')
		.replace(/<p>\s*#{1}\s+(.+?)<\/p>/g, '<h2>$1</h2>'));
}

export function demoteBodyH1(html: string): string {
	return html.replace(/<h1(?=[\s>/])/gi, '<h2').replace(/<\/h1\s*>/gi, '</h2>');
}

// stripHtml (DOMPurify, real HTML parser) instead of a hand-rolled implementation: a single-pass `/<[^>]+>/g` tag-strip can
// leave a reconstructed `<script` behind for crafted input like `<scr<script>ipt>` (CodeQL js/incomplete-multi-character-
// sanitization), and chained entity decodes can double-unescape (CodeQL js/double-escaping). A real HTML parser decodes
// entities exactly once, with no hand-written regex chain.
export function stripTags(s: string): string {
	return stripHtml(s).replace(/\s+/g, ' ').trim();
}

export function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export interface TocEntry {
	id: string;
	text: string;
}

/** Injects stable ids onto every <h2> and collects a table of contents (unchanged from the base blog page). */
export function addHeadingIdsAndToc(html: string): { html: string; toc: TocEntry[] } {
	const toc: TocEntry[] = [];
	const used = new Set<string>();
	const out = html.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/gi, (_m, attrs, inner) => {
		const text = stripTags(inner);
		const base = slugify(text);
		if (!base) return `<h2${attrs || ''}>${inner}</h2>`;
		let id = base;
		let i = 2;
		while (used.has(id)) id = `${base}-${i++}`;
		used.add(id);
		toc.push({ id, text });
		return `<h2 id="${id}"${attrs || ''}>${inner}</h2>`;
	});
	return { html: out, toc };
}

/** The five entities `stripHtml` leaves in its text output; a brand view receives plain text, not escaped markup. */
const decodeEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] as string);

/**
 * The TOC of a SANITISED body: every `<h2 id>` that survived, in document order. A heading whose id the sanitiser dropped (e.g.
 * `id="location"`) has no entry, so every link in the TOC points at an id that is rendered.
 */
export function tocFromSanitized(html: string): TocEntry[] {
	const out: TocEntry[] = [];
	const seen = new Set<string>();
	for (const m of html.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi)) {
		const id = /\bid="([^"]+)"/i.exec(m[1])?.[1];
		if (!id || seen.has(id)) continue;
		const text = decodeEntities(stripTags(m[2]));
		if (!text) continue;
		seen.add(id);
		out.push({ id, text });
	}
	return out;
}

export interface BlogBody {
	body: SanitizedHtml;
	toc: TocEntry[];
}

/**
 * V25: the sanitiser ran on every render of a post. Its output is a pure function of the body bytes and the pipeline, so it
 * is memoised by content revision (the exact input bytes, the key itself — no hash collisions) plus BLOG_BODY_PIPELINE_VERSION
 * (bump on any change to fixBodyHtml/addHeadingIdsAndToc/the `blog` sanitiser policy). Bounded: at most BLOG_BODY_MEMO_MAX
 * entries, bodies over BLOG_BODY_MEMO_MAX_BYTES are never kept, least-recently-used evicted first. Content only — a blog body
 * carries no stock, cart or visitor state.
 */
export const BLOG_BODY_PIPELINE_VERSION = 1;
export const BLOG_BODY_MEMO_MAX = 64;
export const BLOG_BODY_MEMO_MAX_BYTES = 256 * 1024;
const blogBodyMemo = new Map<string, BlogBody>();

/** fixBodyHtml's output -> heading ids + TOC -> `blog` sanitiser policy -> TOC checked against the final body. */
export function buildBlogBody(fixedHtml: string): BlogBody {
	const key = `${BLOG_BODY_PIPELINE_VERSION}\u0000${fixedHtml}`;
	const hit = blogBodyMemo.get(key);
	if (hit) {
		blogBodyMemo.delete(key);
		blogBodyMemo.set(key, hit);
		return { body: hit.body, toc: hit.toc.map((t) => ({ ...t })) };
	}
	const { html } = addHeadingIdsAndToc(fixedHtml);
	const body = toSanitizedHtml(html, 'blog');
	const built = { body, toc: tocFromSanitized(body.html) };
	if (fixedHtml.length <= BLOG_BODY_MEMO_MAX_BYTES) {
		blogBodyMemo.set(key, built);
		while (blogBodyMemo.size > BLOG_BODY_MEMO_MAX) blogBodyMemo.delete(blogBodyMemo.keys().next().value as string);
	}
	return { body: built.body, toc: built.toc.map((t) => ({ ...t })) };
}

/** Test-only. */
export const _blogBodyMemoSize = (): number => blogBodyMemo.size;

export interface RelatedCandidate {
	slug: string;
	tags: readonly string[];
	publishedAt: string | null;
}

/** How many of the latest posts are considered for related ranking. */
export const RELATED_POOL = 40;

/**
 * Shared tags (most first), then recency (newest first), then slug (a-z). The current post is never related to itself. Same ordering
 * as a legacy storefront's `pickRelatedPosts`, over the latest {@link RELATED_POOL} posts; the pool is fetched per request.
 */
export function rankRelatedPosts<T extends RelatedCandidate>(current: { slug: string; tags: readonly string[] }, pool: readonly T[], limit = 3): T[] {
	const mine = new Set(current.tags.map((t) => t.toLowerCase()));
	return pool
		.filter((p) => p.slug !== current.slug)
		.slice(0, RELATED_POOL)
		.map((p) => ({ p, shared: p.tags.filter((t) => mine.has(t.toLowerCase())).length, time: p.publishedAt ? Date.parse(p.publishedAt) || 0 : 0 }))
		.sort((a, b) => b.shared - a.shared || b.time - a.time || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0))
		.slice(0, limit)
		.map((x) => x.p);
}
