import { lazy, Suspense, useState } from 'react';
import { Trash2, Upload, X } from 'lucide-react';
import { assetUrl, uploadAsset } from '../api';
import { ErrorNote, Field, FormSection, Loading, Spinner } from './ui';
import { slugify, type BlogForm } from './blog-editor/blog-post-fields';

// Editor (TipTap/ProseMirror) is its own chunk, fetched only when a post is opened.
const BlogEditor = lazy(() => import('./blog-editor/BlogEditor'));

interface Props {
  value: BlogForm;
  onChange: (next: BlogForm) => void;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}

/** Blog post detail form: field-for-field port of the Vendure BlogPostDetailPage. */
export default function BlogPostForm({ value: f, onChange, saving, error, onSave, onCancel, onDelete }: Props) {
  // An existing post's slug is never re-derived from its title; a new post's follows the title until typed over.
  const [slugManual, setSlugManual] = useState(!!f.id);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const set = (patch: Partial<BlogForm>) => onChange({ ...f, ...patch });

  const upload = async (file: File) => {
    setUploadErr(null); setUploading(true);
    try { const a = await uploadAsset(file); set({ featuredAssetId: a.id, featuredAssetPath: a.path }); }
    catch (e) { setUploadErr((e as Error).message); }
    finally { setUploading(false); }
  };

  const img = assetUrl(f.featuredAssetPath);
  const scheduled = f.isPublished && !!f.publishDate && new Date(f.publishDate).getTime() > Date.now();

  return (
    <div className="card p-4 mb-5 stack-y-4 max-w-4xl">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Title" htmlFor="blog-title">
            <input id="blog-title" className="input" value={f.title} placeholder="Post title"
              onChange={(e) => set({ title: e.target.value, ...(slugManual ? {} : { slug: slugify(e.target.value) }) })} />
          </Field>
        </div>
        <Field label={`Slug${slugManual ? '' : ' (auto)'}`} htmlFor="blog-slug" hint="Used in the post URL. Must be unique.">
          <input id="blog-slug" className="input" value={f.slug} placeholder="post-url-slug"
            onChange={(e) => { const v = e.target.value; setSlugManual(v !== ''); set({ slug: v === '' ? slugify(f.title) : v }); }} />
        </Field>
        <Field label="Author name" htmlFor="blog-author" hint="Shown as the byline (for E-E-A-T).">
          <input id="blog-author" className="input" value={f.authorName} placeholder="e.g. Editorial Team" onChange={(e) => set({ authorName: e.target.value })} />
        </Field>
      </div>

      <Field label="Excerpt" htmlFor="blog-excerpt" hint="Auto-generated (first 160 characters) if left empty.">
        <textarea id="blog-excerpt" className="input min-h-[80px]" rows={3} value={f.excerpt} placeholder="A brief summary..." onChange={(e) => set({ excerpt: e.target.value })} />
      </Field>

      <div>
        <label className="label">Body</label>
        <Suspense fallback={<Loading label="Loading editor" />}>
          <BlogEditor key={f.id ?? 'new'} value={f.body} onChange={(body) => onChange({ ...f, body })} />
        </Suspense>
      </div>

      <div>
        <label className="label">Featured image</label>
        <div className="flex items-start gap-3">
          {img && (
            <div className="relative">
              <img src={img} alt="Featured" className="max-w-[200px] rounded-md border border-line" />
              <button type="button" aria-label="Remove featured image" title="Remove" className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-surface text-muted ring-1 ring-line hover:text-danger"
                onClick={() => set({ featuredAssetId: null, featuredAssetPath: null })}><X size={12} /></button>
            </div>
          )}
          <label className="btn-ghost cursor-pointer">
            {uploading ? <Spinner /> : <Upload size={14} />} {img ? 'Replace' : 'Upload'}
            <input type="file" accept="image/*" className="hidden" disabled={uploading}
              onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.currentTarget.value = ''; }} />
          </label>
        </div>
        {uploadErr && <p className="mt-1 text-xs text-danger">{uploadErr}</p>}
      </div>

      <Field label="Tags" htmlFor="blog-tags" hint="Comma-separated.">
        <input id="blog-tags" className="input" value={f.tags} placeholder="knives, craftsmanship, makers" onChange={(e) => set({ tags: e.target.value })}
          onBlur={(e) => set({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean).join(', ') })} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Visibility</label>
          <div className="flex gap-2" role="group" aria-label="Visibility">
            <button type="button" aria-pressed={!f.isPublished} className={!f.isPublished ? 'btn-primary' : 'btn-ghost'} onClick={() => set({ isPublished: false })}>Draft</button>
            <button type="button" aria-pressed={f.isPublished} className={f.isPublished ? 'btn-primary' : 'btn-ghost'} onClick={() => set({ isPublished: true })}>Published</button>
          </div>
          {scheduled && <p className="mt-1 text-xs text-muted">Scheduled: goes live at the date and time shown.</p>}
          {!f.isPublished && f.publishDate && <p className="mt-1 text-xs text-muted">Drafts are not shown on the storefront. Set to Published to go live at this time.</p>}
        </div>
        <Field label="Schedule publish date & time" htmlFor="blog-date" hint="Leave blank to publish now.">
          <input id="blog-date" className="input" type="datetime-local" value={f.publishDate} onChange={(e) => set({ publishDate: e.target.value })} />
        </Field>
      </div>

      <FormSection title="SEO">
        <Field label="SEO title" htmlFor="blog-seo-title" hint="Defaults to the post title.">
          <input id="blog-seo-title" className="input" value={f.seoTitle} placeholder={f.title || 'SEO title override'} onChange={(e) => set({ seoTitle: e.target.value })} />
        </Field>
        <Field label="SEO description" htmlFor="blog-seo-desc" hint="Defaults to the excerpt.">
          <textarea id="blog-seo-desc" className="input min-h-[60px]" rows={2} value={f.seoDescription} placeholder={f.excerpt || 'SEO description override'} onChange={(e) => set({ seoDescription: e.target.value })} />
        </Field>
      </FormSection>

      {error && <ErrorNote message={error} />}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" disabled={saving || !f.title.trim()} onClick={onSave}>{saving ? <Spinner className="text-white" /> : (f.id ? 'Save' : 'Create')}</button>
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        {onDelete && <button type="button" className="btn-danger ml-auto" onClick={onDelete}><Trash2 size={15} /> Delete</button>}
      </div>
    </div>
  );
}
