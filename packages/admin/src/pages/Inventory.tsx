import { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Check, Boxes } from 'lucide-react';
import { api, type Page, type InventoryRow } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import {
  PageHeader, Pagination, Spinner, Tabs, ResourceToolbar, SearchInput, ResourceTable,
  Badge, EmptyStateActionPanel, type Column, type TabDef,
} from '../components/ui';

const VIEWS: TabDef[] = [
  { key: 'all', label: 'All stock' },
  { key: 'low', label: 'Low stock' },
];

function stockState(available: number): string {
  if (available <= 0) return 'out_of_stock';
  if (available <= 3) return 'low_stock';
  return 'in_stock';
}

export default function Inventory() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [view, setView] = useState('all');
  const [page, setPage] = useState(1);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const low = view === 'low';

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['inventory', store?.slug, q, low, page],
    queryFn: () => api.get<Page<InventoryRow>>(`/inventory?${new URLSearchParams({ q, lowStock: low ? '1' : '', page: String(page), pageSize: '50' })}`),
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: ({ variantId, onHand }: { variantId: string; onHand: number }) => api.patch(`/variants/${variantId}/stock`, { onHand }),
    onSuccess: (_d, vars) => {
      setEdits((m) => { const { [vars.variantId]: _, ...rest } = m; return rest; });
      qc.invalidateQueries({ queryKey: ['inventory', store?.slug] });
      toast.success('Stock saved', `On hand set to ${vars.onHand}`);
    },
    onError: (e) => toast.error('Stock save failed', (e as Error).message),
  });

  const columns: Column<InventoryRow>[] = [
    { key: 'variant', header: 'Variant', render: (r) => (
      <div className="min-w-0"><div className="font-medium truncate">{r.name}</div><div className="text-xs text-gray-400 truncate">{r.productName}</div></div>
    )},
    { key: 'sku', header: 'SKU', width: '16%', render: (r) => <span className="font-mono text-xs text-gray-500">{r.sku}</span> },
    { key: 'status', header: 'Status', align: 'center', width: '12%', render: (r) => <Badge value={stockState(r.available)} /> },
    { key: 'allocated', header: 'Committed', align: 'center', width: '11%', render: (r) => <span className="tnum text-gray-500">{r.allocated}</span> },
    { key: 'available', header: 'Available', align: 'center', width: '11%', render: (r) => <span className={`tnum ${r.available <= 3 ? 'text-warning font-medium' : 'text-gray-700'}`}>{r.available}</span> },
    { key: 'onhand', header: 'On hand', align: 'center', width: '16%', render: (r) => {
      const editing = edits[r.variantId];
      const dirty = editing !== undefined && Number(editing) !== r.onHand;
      return (
        <div className="flex items-center justify-center gap-2">
          <input className="input w-20 text-center tnum py-1.5" type="number" min={0} aria-label={`On hand for ${r.sku}`} value={editing ?? String(r.onHand)} onChange={(e) => setEdits((m) => ({ ...m, [r.variantId]: e.target.value }))} />
          {dirty && <button className="btn-primary btn-sm" aria-label="Save stock" disabled={save.isPending} onClick={() => save.mutate({ variantId: r.variantId, onHand: Number(editing) })}>{save.isPending ? <Spinner className="text-white" /> : <Check size={15} />}</button>}
        </div>
      );
    }},
  ];

  return (
    <>
      <PageHeader title="Inventory" subtitle={data ? `${data.total} variants` : undefined} />

      <ResourceToolbar
        left={<Tabs tabs={VIEWS} value={view} onChange={(k) => { setView(k); setPage(1); }} />}
        right={<SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search SKU or name" className="w-56" />}
      />

      <ResourceTable
        columns={columns}
        rows={data?.items}
        rowKey={(r) => r.variantId}
        loading={isLoading}
        isFetching={isFetching}
        error={error ? (error as Error).message : null}
        onRetry={() => refetch()}
        empty={low
          ? <EmptyStateActionPanel icon={<Boxes size={22} />} title="Nothing is low on stock" description="No variants are at or below the low-stock threshold. That's a good thing." actions={[{ label: 'Show all stock', variant: 'ghost', onClick: () => { setView('all'); setPage(1); } }]} />
          : q
            ? <EmptyStateActionPanel icon={<Boxes size={22} />} title="No matching variants" description="No variants match your search." actions={[{ label: 'Clear search', variant: 'ghost', onClick: () => { setQ(''); setPage(1); } }]} />
            : <EmptyStateActionPanel icon={<Boxes size={22} />} title="No stock-tracked variants" description="Variants with stock tracking will appear here once you add products." actions={[{ label: 'Add product', to: '/products/new' }]} />}
      />

      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
