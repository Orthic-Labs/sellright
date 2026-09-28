import { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Check, Boxes, History } from 'lucide-react';
import { api, type Page, type InventoryRow, type StockMovementRow, type StockLocationRow } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import {
  PageHeader, Pagination, Spinner, Tabs, ResourceToolbar, SearchInput, ResourceTable,
  Badge, EmptyStateActionPanel, Modal, Field, type Column, type TabDef,
} from '../components/ui';
import { dateTime } from '../lib/format';

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkValue, setBulkValue] = useState('');
  const [adjustFor, setAdjustFor] = useState<InventoryRow | null>(null);
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
  // Bulk set: one PATCH, one transaction on the API side (all-or-nothing —
  // see admin-products.ts /v1/admin/variants/stock/bulk). All selected
  // variants are set to the SAME on-hand value; per-variant differing values
  // still go through the single-row editor above.
  const bulkSave = useMutation({
    mutationFn: (items: { id: string; onHand: number }[]) => api.patch<{ updated: { id: string; onHand: number }[] }>('/variants/stock/bulk', { items }),
    onSuccess: (d) => {
      setSelected(new Set());
      setBulkValue('');
      qc.invalidateQueries({ queryKey: ['inventory', store?.slug] });
      toast.success('Stock saved', `${d.updated.length} variant${d.updated.length === 1 ? '' : 's'} set to ${d.updated[0]?.onHand ?? ''}`);
    },
    onError: (e) => toast.error('Bulk stock save failed', (e as Error).message),
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
    { key: 'adjust', header: 'Adjust', align: 'center', width: '9%', render: (r) => (
      <button className="btn-ghost btn-sm" aria-label={`Adjust stock and view history for ${r.sku}`} onClick={() => setAdjustFor(r)}>
        <History size={15} />
      </button>
    )},
  ];

  return (
    <>
      <PageHeader title="Inventory" subtitle={data ? `${data.total} variants` : undefined} />
      {adjustFor && (
        <StockAdjustModal
          row={adjustFor}
          onClose={() => setAdjustFor(null)}
          onAdjusted={() => qc.invalidateQueries({ queryKey: ['inventory', store?.slug] })}
        />
      )}

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
        selection={{
          selectedKeys: selected,
          onToggle: (k) => setSelected((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAllVisible: (keys) => setSelected((cur) => {
            const allSelected = keys.every((k) => cur.has(k));
            const n = new Set(cur);
            if (allSelected) for (const k of keys) n.delete(k); else for (const k of keys) n.add(k);
            return n;
          }),
        }}
        toolbar={(count) => (
          <>
            <input
              className="input w-20 text-center tnum py-1.5"
              type="number"
              min={0}
              aria-label="New on-hand value for selected variants"
              placeholder="On hand"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
            />
            <button
              className="btn-primary btn-sm"
              disabled={bulkSave.isPending || bulkValue === '' || Number(bulkValue) < 0}
              onClick={() => {
                const onHand = Number(bulkValue);
                bulkSave.mutate([...selected].map((id) => ({ id, onHand })));
              }}
            >
              {bulkSave.isPending ? <Spinner className="text-white" /> : <Check size={15} />} Set stock for {count} selected
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          </>
        )}
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

/**
 * Delta + reason adjustment, per-location breakdown, and the append-only
 * adjustment history — the "why is this number what it is" surface. Every
 * adjustment made here is a signed delta with a mandatory reason (never a
 * silent overwrite of on-hand); PATCH /variants/{id}/stock in the main table
 * above still exists for the quick absolute-value edit but this is the
 * audited path.
 */
function StockAdjustModal({ row, onClose, onAdjusted }: { row: InventoryRow; onClose: () => void; onAdjusted: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');

  const history = useQuery({
    queryKey: ['stock-history', row.variantId],
    queryFn: () => api.get<Page<StockMovementRow>>(`/variants/${row.variantId}/stock/history?pageSize=20`),
  });
  const locations = useQuery({
    queryKey: ['stock-locations', row.variantId],
    queryFn: () => api.get<{ items: StockLocationRow[] }>(`/variants/${row.variantId}/stock/locations`),
  });

  const adjust = useMutation({
    mutationFn: () => api.post<{ id: string; onHand: number }>(`/variants/${row.variantId}/stock/adjust`, { delta: Number(delta), reason: reason.trim() }),
    onSuccess: (d) => {
      setDelta(''); setReason('');
      toast.success('Stock adjusted', `On hand is now ${d.onHand}`);
      qc.invalidateQueries({ queryKey: ['stock-history', row.variantId] });
      onAdjusted();
    },
    onError: (e) => toast.error('Adjustment failed', (e as Error).message),
  });

  const deltaNum = Number(delta);
  const canSubmit = delta.trim() !== '' && Number.isInteger(deltaNum) && deltaNum !== 0 && reason.trim().length > 0;

  return (
    <Modal open title={`Adjust stock — ${row.sku}`} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div className="text-sm text-gray-500">
          {row.name} · On hand <span className="font-medium text-ink tnum">{row.onHand}</span> · Committed <span className="font-medium text-ink tnum">{row.allocated}</span> · Available <span className="font-medium text-ink tnum">{row.available}</span>
        </div>

        <form className="grid grid-cols-[7rem_1fr_auto] gap-2 items-end" onSubmit={(e) => { e.preventDefault(); if (canSubmit) adjust.mutate(); }}>
          <Field label="Delta" hint="+/-">
            <input className="input tnum" type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="e.g. -2 or 10" aria-label="Stock adjustment delta" />
          </Field>
          <Field label="Reason">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. damaged in warehouse, cycle count correction" aria-label="Reason for adjustment" />
          </Field>
          <button type="submit" className="btn-primary" disabled={!canSubmit || adjust.isPending}>
            {adjust.isPending ? <Spinner className="text-white" /> : <Check size={15} />} Apply
          </button>
        </form>

        {locations.data && locations.data.items.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">By location</h3>
            <table className="w-full text-sm">
              <tbody>
                {locations.data.items.map((l) => (
                  <tr key={l.locationId} className="border-t border-gray-100 first:border-0">
                    <td className="td py-1">{l.name}</td>
                    <td className="td py-1 text-right tnum">{l.onHand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Adjustment history</h3>
          {history.isLoading ? <Spinner /> : !history.data?.items.length ? (
            <p className="text-sm text-gray-400">No adjustments recorded yet.</p>
          ) : (
            <ul className="space-y-1.5 max-h-56 overflow-y-auto">
              {history.data.items.map((m) => (
                <li key={m.id} className="text-xs text-gray-500 flex items-center justify-between gap-2">
                  <span>
                    <span className={`tnum font-medium ${m.delta > 0 ? 'text-success' : 'text-danger'}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</span>
                    {' — '}{m.reason}{m.actor ? ` (${m.actor})` : ''}
                  </span>
                  <span className="shrink-0">{dateTime(m.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
