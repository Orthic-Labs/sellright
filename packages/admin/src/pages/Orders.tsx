import { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Plus, Download, Upload, ShoppingCart, ShoppingBag, Trash2, Truck, CheckCircle2, Ban, RotateCcw } from 'lucide-react';
import { api, downloadFile, type Page, type OrderRow } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { money, dateTime } from '../lib/format';
import {
  Badge, PageHeader, Pagination, Tabs, ResourceToolbar, SearchInput, ResourceTable,
  ActionMenu, EmptyStateActionPanel, InlineAlert, type Column, type TabDef,
} from '../components/ui';

type BulkResult = { results: { code: string; ok: boolean; error?: string }[]; succeeded: number; skipped: number };

const TABS: (TabDef & { pre?: boolean })[] = [
  { key: '', label: 'All' },
  { key: 'PendingPayment', label: 'Pending' },
  { key: 'Paid', label: 'Paid' },
  { key: 'preorder', label: 'Pre-orders', pre: true },
  { key: 'Cancelled', label: 'Cancelled' },
  { key: 'Refunded', label: 'Refunded' },
  { key: 'trash', label: 'Trash' },
];

// Built-in + user-defined saved views. User presets live in localStorage and
// override nothing — URL params remain the source of truth.
const SAVED_VIEW_KEY = 'sr_orders_saved_views_v1';
const BUILTIN_VIEWS: { id: string; label: string; state: string; q?: string; preOrder?: boolean }[] = [
  { id: 'all', label: 'All', state: '' },
  { id: 'paid', label: 'Paid', state: 'Paid' },
  { id: 'pending', label: 'Pending', state: 'PendingPayment' },
  { id: 'preorder', label: 'Pre-orders', state: '', preOrder: true },
  { id: 'cancelled', label: 'Cancelled', state: 'Cancelled' },
  { id: 'refunded', label: 'Refunded', state: 'Refunded' },
  { id: 'trash', label: 'Trash', state: 'trash' },
];

interface UserView {
  id: string;
  name: string;
  state: string;
  preOrder: boolean;
  q: string;
}

function loadUserViews(): UserView[] {
  try { const raw = localStorage.getItem(SAVED_VIEW_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function saveUserViews(views: UserView[]) { try { localStorage.setItem(SAVED_VIEW_KEY, JSON.stringify(views)); } catch { /* noop */ } }

export default function Orders() {
  const { store } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    if (params.get('preOrder') === '1') return 'preorder';
    const s = params.get('state') ?? '';
    return TABS.some((t) => t.key === s) ? s : '';
  });
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const isPre = tab === 'preorder';
  const trashed = tab === 'trash';
  const state = isPre || trashed ? '' : tab;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [userViews, setUserViews] = useState<UserView[]>(() => loadUserViews());
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['orders', store?.slug, tab, q, page],
    queryFn: () => api.get<Page<OrderRow>>(`/orders?${new URLSearchParams({ state, q, preOrder: isPre ? '1' : '', trashed: trashed ? '1' : '', page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });

  // Clear selection on filter/page changes — v1 doesn't carry selection across
  // pages. The bulk toolbar disappears until you re-select on the new page.
  function changeTab(t: string) { setTab(t); setPage(1); setSelected(new Set()); setBulkResult(null); }
  function changeQuery(v: string) { setQ(v); setPage(1); setSelected(new Set()); }
  function changePage(p: number) { setPage(p); setSelected(new Set()); }

  async function exportCsv() {
    setExporting(true);
    try { await downloadFile(`/export/orders?days=365${state ? `&state=${state}` : ''}`, `orders-${store?.slug ?? 'store'}.csv`); toast.success('Export started'); }
    catch (e) { toast.error('Export failed', (e as Error).message); }
    finally { setExporting(false); }
  }

  function exportSelectedCsv() {
    const rows = (data?.items ?? []).filter((o) => selected.has(o.code));
    if (!rows.length) return;
    const cell = (v: unknown) => {
      const raw = v == null ? '' : String(v);
      const s = /^[=+\-@|%]/.test(raw) ? `\t${raw}` : raw;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      ['code', 'date', 'email', 'state', 'preOrder', 'total', 'currency'].join(','),
      ...rows.map((o) => [
        o.code,
        o.placedAt ?? o.createdAt,
        o.email ?? '',
        o.state,
        o.isPreOrder ? 'yes' : '',
        (o.grandTotal / 100).toFixed(2),
        o.currency,
      ].map(cell).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders-selected-${store?.slug ?? 'store'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} selected order${rows.length === 1 ? '' : 's'}`);
  }

  // Bulk operations — server-side fan-out. Every endpoint returns the same
  // {results, succeeded, skipped} shape; the result panel below renders whichever
  // bulk action ran last (tracked in bulkResult).
  function onBulkDone(verb: string) {
    return (r: BulkResult) => {
      const failed = r.results.filter((x) => !x.ok).length;
      if (failed === 0) toast.success(`${r.succeeded} order${r.succeeded === 1 ? '' : 's'} ${verb}`);
      else toast.error(`${r.succeeded} succeeded, ${failed} failed`, 'See the result panel below for codes.');
      qc.invalidateQueries({ queryKey: ['orders', store?.slug] });
      setBulkResult(r);
      // Keep only failed rows selected so the operator can inspect or retry them.
      setSelected(new Set(r.results.filter((x) => !x.ok).map((x) => x.code)));
    };
  }
  // window.confirm rejection throws 'cancelled' — swallow it (not a real error).
  const onBulkErr = (e: unknown) => { if ((e as Error).message === 'cancelled') return; toast.error('Bulk action failed', (e as Error).message); };

  const bulkFulfill = useMutation({
    mutationFn: (payload: { state: 'Shipped' | 'Delivered' }) => api.post<BulkResult>(`/orders/bulk-fulfill`, {
      orders: [...selected].map((code) => ({ code, state: payload.state })),
    }),
    onSuccess: (r, payload) => onBulkDone(`marked ${payload.state.toLowerCase()}`)(r),
    onError: onBulkErr,
  });

  function bulkOrderAction(path: 'bulk-cancel' | 'bulk-soft-delete' | 'bulk-restore' | 'bulk-purge', extra?: Record<string, unknown>) {
    return api.post<BulkResult>(`/orders/${path}`, { codes: [...selected], ...extra });
  }
  const bulkCancel = useMutation({ mutationFn: () => bulkOrderAction('bulk-cancel'), onSuccess: onBulkDone('cancelled'), onError: onBulkErr });
  const bulkTrash = useMutation({ mutationFn: () => bulkOrderAction('bulk-soft-delete'), onSuccess: onBulkDone('moved to trash'), onError: onBulkErr });
  const bulkRestore = useMutation({ mutationFn: () => bulkOrderAction('bulk-restore'), onSuccess: onBulkDone('restored'), onError: onBulkErr });
  const bulkPurge = useMutation({
    mutationFn: () => {
      if (!window.confirm(`Permanently delete ${selected.size} order(s)? This cannot be undone.`)) throw new Error('cancelled');
      return bulkOrderAction('bulk-purge');
    },
    onSuccess: onBulkDone('purged'),
    onError: onBulkErr,
  });
  const bulkPending = bulkFulfill.isPending || bulkCancel.isPending || bulkTrash.isPending || bulkRestore.isPending || bulkPurge.isPending;

  const columns: Column<OrderRow>[] = [
    { key: 'code', header: 'Order', width: '20%', render: (o) => (
      <span className="font-medium">{o.code}{o.isPreOrder && <span className="ml-1.5 align-middle text-[10px] uppercase font-semibold text-warning bg-warning-soft rounded px-1 py-0.5">pre-order</span>}</span>
    )},
    { key: 'date', header: 'Date', width: '22%', render: (o) => <span className="text-gray-500">{dateTime(o.placedAt ?? o.createdAt)}</span> },
    { key: 'customer', header: 'Customer', render: (o) => <span className="text-gray-600 truncate block">{o.email ?? '—'}</span> },
    { key: 'status', header: 'Payment', width: '16%', render: (o) => <Badge value={o.state} /> },
    { key: 'total', header: 'Total', align: 'right', width: '15%', render: (o) => <span className="font-medium tnum">{money(o.grandTotal, o.currency)}</span> },
  ];

  const isFiltered = !!q || !!tab;

  function saveCurrentView() {
    const name = window.prompt('Name this view:');
    if (!name?.trim()) return;
    const next: UserView = { id: `u${Date.now()}`, name: name.trim(), state, preOrder: isPre, q };
    const updated = [...userViews, next];
    setUserViews(updated);
    saveUserViews(updated);
    toast.success('View saved');
  }

  function deleteView(id: string) {
    const updated = userViews.filter((v) => v.id !== id);
    setUserViews(updated);
    saveUserViews(updated);
  }

  function applyView(v: { state: string; q?: string; preOrder?: boolean }) {
    const newState = v.preOrder ? 'preorder' : v.state;
    setTab(newState);
    setQ(v.q ?? '');
    setPage(1);
    setSelected(new Set());
    setParams(new URLSearchParams({ state: v.state, q: v.q ?? '', preOrder: v.preOrder ? '1' : '' }));
  }

  return (
    <>
      <PageHeader title="Orders" subtitle={data ? `${data.total} total` : undefined} actions={
        <div className="flex items-center gap-2">
          <ActionMenu label="Actions" items={[
            { label: exporting ? 'Exporting…' : 'Export CSV', icon: <Download size={15} />, onClick: exportCsv, disabled: exporting },
            { label: 'Import tracking', icon: <Upload size={15} />, to: '/orders/import-tracking' },
            { label: 'Abandoned carts', icon: <ShoppingCart size={15} />, to: '/abandoned-carts' },
            { label: 'Save current as view', icon: <Plus size={15} />, onClick: saveCurrentView },
          ]} />
          <Link to="/orders/new" className="btn-primary whitespace-nowrap"><Plus size={16} /> New order</Link>
        </div>
      } />

      {/* Saved views strip */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {BUILTIN_VIEWS.map((v) => {
          const active = v.preOrder ? isPre && !q : v.state === 'trash' ? trashed && !q : !isPre && !trashed && state === v.state && !q;
          return (
            <button key={v.id} className={`btn-ghost btn-sm ${active ? '!bg-brand-light !text-brand !border-brand/30' : ''}`} onClick={() => applyView(v)}>
              {v.label}
            </button>
          );
        })}
        {userViews.length > 0 && <span className="mx-1 text-gray-300">|</span>}
        {userViews.map((v) => {
          const active = !isPre && state === v.state && q === v.q;
          return (
            <span key={v.id} className={`inline-flex items-center rounded-md border ${active ? 'bg-brand-light border-brand/30 text-brand' : 'bg-surface border-gray-300 text-gray-700'}`}>
              <button className="px-2.5 py-1 text-xs" onClick={() => applyView(v)}>{v.name}</button>
              <button aria-label={`Delete view ${v.name}`} className="px-1.5 py-1 text-gray-400 hover:text-danger" onClick={() => deleteView(v.id)}><Trash2 size={12} /></button>
            </span>
          );
        })}
      </div>

      <ResourceToolbar
        left={<Tabs tabs={TABS} value={tab} onChange={changeTab} />}
        right={<SearchInput value={q} onChange={changeQuery} placeholder="Search code or email" />}
      />

      <ResourceTable
        columns={columns}
        rows={data?.items}
        rowKey={(o) => o.code}
        onRowClick={(o) => nav(`/orders/${o.code}`)}
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
        toolbar={() => (
          trashed ? (
            <>
              <button className="btn-ghost btn-sm" onClick={() => bulkRestore.mutate()} disabled={bulkPending}><RotateCcw size={13} /> Restore</button>
              <button className="btn-ghost btn-sm text-danger" onClick={() => bulkPurge.mutate()} disabled={bulkPending}><Trash2 size={13} /> Delete permanently</button>
              <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
            </>
          ) : (
            <>
              <button className="btn-ghost btn-sm" onClick={() => bulkFulfill.mutate({ state: 'Shipped' })} disabled={bulkPending}><Truck size={13} /> Mark shipped</button>
              <button className="btn-ghost btn-sm" onClick={() => bulkFulfill.mutate({ state: 'Delivered' })} disabled={bulkPending}><CheckCircle2 size={13} /> Mark delivered</button>
              <button className="btn-ghost btn-sm" onClick={() => bulkCancel.mutate()} disabled={bulkPending}><Ban size={13} /> Cancel</button>
              <button className="btn-ghost btn-sm" onClick={() => bulkTrash.mutate()} disabled={bulkPending}><Trash2 size={13} /> Delete</button>
              <button className="btn-ghost btn-sm" onClick={exportSelectedCsv} disabled={bulkPending}><Download size={13} /> Export selected</button>
              <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
            </>
          )
        )}
        empty={isFiltered
          ? <EmptyStateActionPanel icon={<ShoppingBag size={22} />} title="No matching orders" description="No orders match this filter or search. Try clearing it." actions={[{ label: 'Clear filters', variant: 'ghost', onClick: () => { changeTab(''); changeQuery(''); } }]} />
          : <EmptyStateActionPanel icon={<ShoppingBag size={22} />} title="No orders yet" description="Orders placed in your store will appear here. You can also create an order manually." actions={[{ label: 'New order', to: '/orders/new', icon: <Plus size={16} /> }]} />}
      />

      {bulkResult && bulkResult.results.some((r) => !r.ok) && (
        <div className="mt-3">
          <InlineAlert
            tone="critical"
            title={`${bulkResult.succeeded} succeeded, ${bulkResult.skipped} skipped, ${bulkResult.results.filter((r) => !r.ok).length} failed`}
          >
            <ul className="mt-1 text-xs space-y-0.5">
              {bulkResult.results.filter((r) => !r.ok).map((r) => <li key={r.code}><span className="font-mono">{r.code}</span> — {r.error}</li>)}
            </ul>
          </InlineAlert>
        </div>
      )}

      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={changePage} />}
    </>
  );
}
