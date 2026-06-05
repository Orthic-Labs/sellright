import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner } from '../components/ui';
import { date } from '../lib/format';

interface Post { id: string; title: string; slug: string; isPublished: boolean; publishDate: string | null; authorName: string | null; }
interface Draft { id?: string; title: string; body: string; excerpt: string; isPublished: boolean; }

export default function Blog() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const key = ['blog', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Post[] }>('/blog') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const open = async (id: string) => { const p = await api.get<any>(`/blog/${id}`); setDraft({ id: p.id, title: p.title, body: p.bodyHtml ?? p.body ?? '', excerpt: p.excerpt ?? '', isPublished: p.isPublished }); };
  const save = useMutation({
    mutationFn: () => draft!.id ? api.patch(`/blog/${draft!.id}`, draft) : api.post('/blog', draft),
    onSuccess: () => { setDraft(null); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/blog/${id}`), onSuccess: () => { setDraft(null); invalidate(); } });

  return (
    <>
      <PageHeader title="Blog" subtitle="Posts for the storefront blog." actions={
        <button className="btn-primary" onClick={() => setDraft({ title: '', body: '', excerpt: '', isPublished: false })}><Plus size={16} /> New post</button>
      } />

      {draft && (
        <div className="card p-4 mb-5 space-y-3 max-w-3xl">
          <div><label className="label">Title</label><input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
          <div><label className="label">Excerpt</label><input className="input" value={draft.excerpt} onChange={(e) => setDraft({ ...draft, excerpt: e.target.value })} /></div>
          <div><label className="label">Body (HTML)</label><textarea className="input min-h-[240px] font-mono text-sm" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={draft.isPublished} onChange={(e) => setDraft({ ...draft, isPublished: e.target.checked })} /> Published</label>
          {save.error && <ErrorNote message={(save.error as Error).message} />}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={save.isPending || !draft.title.trim()} onClick={() => save.mutate()}>{save.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
            <button className="btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
            {draft.id && <button className="btn-danger ml-auto" onClick={() => { if (confirm('Delete this post?')) del.mutate(draft.id!); }}><Trash2 size={15} /> Delete</button>}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? <EmptyState title="No posts yet" /> : (
          <table className="w-full">
            <thead><tr><th className="th">Title</th><th className="th">Author</th><th className="th">Status</th><th className="th">Date</th></tr></thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="row-link" onClick={() => open(p.id)}>
                  <td className="td font-medium">{p.title}</td>
                  <td className="td text-gray-500">{p.authorName}</td>
                  <td className="td"><Badge value={p.isPublished ? 'active' : 'draft'} /></td>
                  <td className="td text-gray-500">{p.publishDate ? date(p.publishDate) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
