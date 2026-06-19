import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, X, Search } from 'lucide-react';
import { api, type CollectionDetail, type Page, type ProductRow } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, Badge } from '../components/ui';

export default function CollectionDetailPage() {
  const { id = '' } = useParams();
  const { store } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');

  const key = ['collection', store?.slug, id];
  const { data: col, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<CollectionDetail>(`/collections/${id}`) });
  const search = useQuery({
    queryKey: ['product-search', store?.slug, q],
    queryFn: () => api.get<Page<ProductRow>>(`/products?${new URLSearchParams({ q, pageSize: '6' })}`),
    enabled: q.trim().length > 1,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const add = useMutation({ mutationFn: (productId: string) => api.post(`/collections/${id}/products`, { productId }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (productId: string) => api.del(`/collections/${id}/products/${productId}`), onSuccess: invalidate });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote message={(error as Error).message} />;
  if (!col) return null;
  const inCollection = new Set(col.products.map((p) => p.id));

  return (
    <>
      <Link to="/collections" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Collections</Link>
      <h1 className="text-xl font-semibold tracking-tight mb-1">{col.name}</h1>
      <div className="text-sm text-gray-400 font-mono mb-5">/{col.slug}</div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Products in this collection ({col.products.length})</div>
          {col.products.length === 0 ? <div className="p-6 text-sm text-gray-400 text-center">No products yet — add some on the right.</div> : (
            <table className="w-full">
              <tbody>
                {col.products.map((p) => (
                  <tr key={p.id} className="border-t border-gray-100 first:border-0">
                    <td className="td"><Link to={`/products/${p.id}`} className="font-medium hover:text-brand">{p.name}</Link></td>
                    <td className="td"><Badge value={p.status} /></td>
                    <td className="td text-right"><button className="text-gray-400 hover:text-danger" onClick={() => remove.mutate(p.id)} title="Remove"><X size={16} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card p-4">
          <div className="text-sm font-semibold mb-2">Add products</div>
          <div className="relative mb-3">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pl-9" placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {search.isFetching && <div className="text-xs text-gray-400">Searching…</div>}
          <div className="space-y-1">
            {search.data?.items.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm py-1">
                <span className="truncate">{p.name}</span>
                {inCollection.has(p.id)
                  ? <span className="text-xs text-gray-400">added</span>
                  : <button className="btn-ghost py-1 px-2" disabled={add.isPending} onClick={() => add.mutate(p.id)}><Plus size={14} /></button>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
