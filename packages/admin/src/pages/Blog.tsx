import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge } from '../components/ui';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import BlogPostForm from '../components/BlogPostForm';
import { EMPTY_BLOG_FORM, detailToForm, formToPayload, type BlogDetail, type BlogForm, type BlogListItem } from '../components/blog-editor/blog-post-fields';
import { date } from '../lib/format';

export default function Blog() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const key = ['blog', store?.slug];
  // The API lists newest-created first (the Vendure list sorted createdAt DESC).
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: BlogListItem[] }>('/blog') });
  const [draft, setDraft] = useState<BlogForm | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const load = async (id: string) => detailToForm(await api.get<BlogDetail>(`/blog/${id}`));
  const open = async (id: string) => { setSaveError(null); setDraft(await load(id)); };
  const save = useMutation({
    mutationFn: async (f: BlogForm) => {
      let id = f.id;
      if (id) await api.patch(`/blog/${id}`, formToPayload(f));
      else id = (await api.post<{ id: string }>('/blog', formToPayload(f))).id;
      return load(id); // re-read: slug, auto excerpt and revision are server-decided
    },
    onSuccess: (fresh, f) => {
      setSaveError(null);
      // An update keeps the mounted editor's content; a created post switches to its own id (and so re-keys the editor).
      setDraft((cur) => (cur ? { ...fresh, body: f.id ? cur.body : fresh.body } : cur));
      toast.success(f.id ? 'Post saved' : 'Post created');
      invalidate();
    },
    // 409 carries the clear message (slug already in use / post changed in another tab).
    onError: (e) => setSaveError((e as Error).message),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/blog/${id}`), onSuccess: () => { setDraft(null); invalidate(); } });
  const confirmDelete = async (id: string) => { if (await confirm({ title: 'Delete this post?', tone: 'danger', confirmLabel: 'Delete' })) del.mutate(id); };

  return (
    <>
      {confirmDialog}
      <PageHeader title="Blog" subtitle="Posts for the storefront blog." actions={
        <button className="btn-primary" onClick={() => { setSaveError(null); setDraft({ ...EMPTY_BLOG_FORM }); }}><Plus size={16} /> New post</button>
      } />

      {draft && (
        <BlogPostForm key={draft.id ?? 'new'} value={draft} onChange={setDraft} saving={save.isPending} error={saveError}
          onSave={() => save.mutate(draft)} onCancel={() => setDraft(null)}
          onDelete={draft.id ? () => confirmDelete(draft.id!) : undefined} />
      )}

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? <EmptyState title="No posts yet" hint="Create your first post to get started." /> : (
          <table className="w-full">
            <thead><tr><th className="th">Title</th><th className="th">Status</th><th className="th">Date</th><th className="th">Read</th><th className="th">Tags</th><th className="th" /></tr></thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="row-link" onClick={() => open(p.id)}>
                  <td className="td font-medium">{p.title}</td>
                  <td className="td"><Badge value={p.isPublished ? 'active' : 'draft'} label={p.isPublished ? 'Published' : 'Draft'} /></td>
                  <td className="td text-gray-500">{date(p.publishDate ?? p.createdAt)}</td>
                  <td className="td text-gray-500">{p.readingTime ? `${p.readingTime} min` : '—'}</td>
                  <td className="td text-gray-500 text-sm">{p.tags?.length ? p.tags.join(', ') : '—'}</td>
                  <td className="td"><button type="button" className="btn-ghost text-danger" aria-label={`Delete ${p.title}`} onClick={(e) => { e.stopPropagation(); void confirmDelete(p.id); }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
