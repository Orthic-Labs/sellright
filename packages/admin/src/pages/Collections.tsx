import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, type CollectionRow } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Spinner } from '../components/ui';

export default function Collections() {
  const { store } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['collections', store?.slug],
    queryFn: () => api.get<{ items: CollectionRow[] }>('/collections'),
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/collections', { name }),
    onSuccess: (r) => { setName(''); setCreating(false); qc.invalidateQueries({ queryKey: ['collections', store?.slug] }); nav(`/collections/${r.id}`); },
  });

  return (
    <>
      <PageHeader title="Collections" subtitle="Group products into categories for navigation." actions={
        <button className="btn-primary" onClick={() => setCreating((v) => !v)}><Plus size={16} /> New collection</button>
      } />

      {creating && (
        <form className="card p-4 mb-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="flex-1"><label className="label">Name</label><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fixed Blades" /></div>
          <button className="btn-primary" disabled={!name.trim() || create.isPending}>{create.isPending ? <Spinner className="text-white" /> : 'Create'}</button>
          <button type="button" className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
        </form>
      )}
      {create.error && <div className="mb-4"><ErrorNote message={(create.error as Error).message} /></div>}

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? (
          <EmptyState title="No collections yet" hint="Create one to group products." />
        ) : (
          <table className="w-full">
            <thead><tr><th className="th">Collection</th><th className="th">Handle</th><th className="th text-right">Products</th></tr></thead>
            <tbody>
              {data.items.map((cl) => (
                <tr key={cl.id} className="row-link" onClick={() => nav(`/collections/${cl.id}`)}>
                  <td className="td font-medium">{cl.name}</td>
                  <td className="td font-mono text-xs text-gray-500">{cl.slug}</td>
                  <td className="td text-right text-gray-600">{cl.products}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
