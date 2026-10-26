/** Pure form helpers for the blog post editor (Vendure BlogPostDetailPage.tsx / utils.ts parity). */

export interface BlogForm {
  id?: string;
  title: string;
  slug: string;
  excerpt: string;
  /** HTML (the editor's stored format; the API sanitises it on write). */
  body: string;
  authorName: string;
  /** Comma-separated, exactly as typed. */
  tags: string;
  isPublished: boolean;
  /** `<input type="datetime-local">` value, local time; '' = none. */
  publishDate: string;
  seoTitle: string;
  seoDescription: string;
  featuredAssetId: string | null;
  featuredAssetPath: string | null;
  /** Conditional-write token from the last read; sent back as expectedRevision. */
  revision?: string;
}

export const EMPTY_BLOG_FORM: BlogForm = {
  title: '', slug: '', excerpt: '', body: '', authorName: '', tags: '',
  isPublished: false, publishDate: '', seoTitle: '', seoDescription: '',
  featuredAssetId: null, featuredAssetPath: null,
};

/** Auto slug from a title (Vendure utils.ts slugify; repeated hyphens collapsed). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 200)
    .replace(/-+$/, '');
}

export function parseTags(raw: string): string[] {
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO instant -> datetime-local value in the viewer's local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (local time) -> ISO instant; blank/invalid -> null. */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface BlogDetail {
  id: string; title: string; slug: string; excerpt: string | null; body: string | null; bodyHtml: string | null;
  authorName: string | null; tags: string[] | null; isPublished: boolean; publishDate: string | null;
  seoTitle: string | null; seoDescription: string | null; featuredAssetId: string | null; featuredAssetPath?: string | null;
  seoRevision?: string;
}

/** API detail -> form. The author is shown as stored (never substituted with the staff email). */
export function detailToForm(p: BlogDetail): BlogForm {
  return {
    id: p.id, title: p.title, slug: p.slug, excerpt: p.excerpt ?? '', body: p.bodyHtml ?? p.body ?? '',
    authorName: p.authorName ?? '', tags: (p.tags ?? []).join(', '),
    isPublished: p.isPublished, publishDate: toLocalInput(p.publishDate),
    seoTitle: p.seoTitle ?? '', seoDescription: p.seoDescription ?? '',
    featuredAssetId: p.featuredAssetId ?? null, featuredAssetPath: p.featuredAssetPath ?? null,
    revision: p.seoRevision,
  };
}

/** Form -> POST/PATCH body. Updates carry expectedRevision so a stale tab cannot overwrite a newer edit. */
export function formToPayload(f: BlogForm): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: f.title.trim(), slug: f.slug.trim(), excerpt: f.excerpt, body: f.body, authorName: f.authorName.trim(),
    tags: parseTags(f.tags), isPublished: f.isPublished, publishDate: fromLocalInput(f.publishDate),
    seoTitle: f.seoTitle, seoDescription: f.seoDescription, featuredAssetId: f.featuredAssetId,
  };
  // A blank slug on create is derived from the title by the API; sending '' would be rejected.
  if (!f.id && !f.slug.trim()) delete out.slug;
  if (f.id && f.revision) out.expectedRevision = f.revision;
  return out;
}

export interface BlogListItem {
  id: string; title: string; slug: string; isPublished: boolean; publishDate: string | null;
  authorName: string | null; readingTime: number | null; tags: string[] | null; createdAt: string | null;
}
