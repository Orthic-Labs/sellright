import { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Search, Check } from 'lucide-react';
import { api, type Page, type InventoryRow } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Pagination, Spinner } from '../components/ui';

export default function Inventory() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const [page, setPage] = useState(1);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const key = ['inventory', store?.slug, q, low, page];
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Page<InventoryRow>>(`/inventory?${new URLSearchParams({ q, lowStock: low ? '1' : '', page: String(page), pageSize: '50' })}`),
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: ({ variantId, onHand }: { variantId: string; onHand: number }) => api.patch(`/variants/${variantId}/stock`, { onHand }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', store?.slug] }),
  });

  return (
    <>
      <PageHeader title="Inventory" subtitle={data ? `${data.total} variants` : undefined} actions={
        <div className="flex items-center gap-2">
          <button onClick={() => { setLow((v) => !v); setPage(1); }} className={`px-3 py-2 text-sm rounded-lg border ${low ? 'bg-brand-light text-brand border-brand/30 font-medium' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>Low stock</button>
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pl-9 w-56" placeholder="Search sku or name" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
        </div>
      } />

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? (
          <EmptyState title="No variants" />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Variant</th><th className="th">SKU</th><th className="th text-center">Allocated</th><th className="th text-center">Available</th><th className="th text-center">On hand</th>
            </tr></thead>
            <tbody className={isFetching ? 'opacity-60' : ''}>
              {data.items.map((r) => {
                const editing = edits[r.variantId];
                const dirty = editing !== undefined && Number(editing) !== r.onHand;
                return (
                  <tr key={r.variantId} className="border-t border-gray-100">
                    <td className="td"><div className="font-medium">{r.name}</div><div className="text-xs text-gray-400">{r.productName}</div></td>
                    <td className="td font-mono text-xs text-gray-500">{r.sku}</td>
                    <td className="td text-center text-gray-500">{r.allocated}</td>
                    <td className="td text-center"><span className={r.available <= 3 ? 'text-amber-600 font-medium' : 'text-gray-700'}>{r.available}</span></td>
                    <td className="td">
                      <div className="flex items-center justify-center gap-2">
                        <input className="input w-20 text-center" type="number" min={0} value={editing ?? String(r.onHand)} onChange={(e) => setEdits((m) => ({ ...m, [r.variantId]: e.target.value }))} />
                        {dirty && <button className="btn-primary py-1.5 px-2" disabled={save.isPending} onClick={() => save.mutate({ variantId: r.variantId, onHand: Number(editing) })}>{save.isPending ? <Spinner className="text-white" /> : <Check size={15} />}</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
