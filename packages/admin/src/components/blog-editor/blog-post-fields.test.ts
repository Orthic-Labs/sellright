import { describe, expect, it } from 'vitest';
import { detailToForm, formToPayload, EMPTY_BLOG_FORM, fromLocalInput, parseTags, slugify, toLocalInput } from './blog-post-fields';

describe('blog post form helpers', () => {
  it('slugify matches the Vendure auto-slug', () => {
    expect(slugify('D2 vs. 14C28N vs. S35VN: Which Steel?')).toBe('d2-vs-14c28n-vs-s35vn-which-steel');
    expect(slugify('  Hello   World_ok  ')).toBe('hello-world-ok');
    expect(slugify('a - b')).toBe('a-b');
    expect(slugify('!!!')).toBe('');
    expect(slugify('x'.repeat(300))).toHaveLength(200);
  });

  it('parses comma-separated tags, trimming blanks', () => {
    expect(parseTags(' knives, , craftsmanship ,makers')).toEqual(['knives', 'craftsmanship', 'makers']);
    expect(parseTags('')).toEqual([]);
  });

  it('round-trips a scheduled publish date through the datetime-local value', () => {
    const iso = '2030-03-04T05:06:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBeNull();
  });

  it('never substitutes the staff email for the author, and defaults it empty', () => {
    expect(EMPTY_BLOG_FORM.authorName).toBe('');
    const f = detailToForm({ id: 'i', title: 'T', slug: 's', excerpt: null, body: '<p>raw</p>', bodyHtml: null, authorName: null, tags: null, isPublished: false, publishDate: null, seoTitle: null, seoDescription: null, featuredAssetId: null });
    expect(f.authorName).toBe('');
    expect(f.body).toBe('<p>raw</p>');
  });

  it('builds payloads: create omits a blank slug, update sends expectedRevision and the (possibly changed) slug', () => {
    const create = formToPayload({ ...EMPTY_BLOG_FORM, title: ' New ', tags: 'a, b' });
    expect(create).not.toHaveProperty('slug');
    expect(create).not.toHaveProperty('expectedRevision');
    expect(create).toMatchObject({ title: 'New', tags: ['a', 'b'], publishDate: null, isPublished: false });
    const rev = 'a'.repeat(64);
    const update = formToPayload({ ...EMPTY_BLOG_FORM, id: 'x', title: 'T', slug: 'new-slug', revision: rev, featuredAssetId: 'asset-1' });
    expect(update).toMatchObject({ slug: 'new-slug', expectedRevision: rev, featuredAssetId: 'asset-1' });
  });
});
