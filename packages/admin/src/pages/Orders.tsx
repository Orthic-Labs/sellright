import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Download, Search, Columns3, ChevronLeft, ChevronRight, Ellipsis, Trash2 } from 'lucide-react';
import { api, type Page, type OrderRow } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { useForcePurgeDialog, isPaidPurgeState } from '../components/ForcePurgeDialog';
import OrderExportDialog from '../components/OrderExportDialog';
import AutoDeliverDialog from '../components/AutoDeliverDialog';
import { money, dateTime } from '../lib/format';
import { EMPTY_FILTERS, PAYMENT_OPTIONS, customerLabel, paymentDef } from '../lib/order-status';
import { EmptyState, FilteredEmpty, LoadError, LoadingRows } from '../redesign/states';
import { FulfilDialog } from '../redesign/FulfilDialog';
import OrderInspector from '../redesign/OrderInspector';
import { FilterChip, PillView, Popover } from '../redesign/orders-ui';
import {
  COL_LABELS, DEFAULT_TAB, TABS, UNCOUNTED, fulfilmentPill, isTabKey, loadCols, loadViews, paymentPill, storeCols, storeViews,
  validateViewName, type ColKey, type Cols, type SavedView, type TabKey,
} from '../redesign/orders-helpers';

type BulkResult = { results: { code: string; ok: boolean; error?: string }[]; succeeded: number; skipped: number };
const PAGE_SIZE = 25;
const PANEL_ID = 'orders-panel';
const tabId = (k: string) => `orders-tab-${k}`;

export default function Orders() {
  const { store } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const { ask: askForcePurge, dialog: forcePurgeDialog } = useForcePurgeDialog();
  const [params, setParams] = useSearchParams();

  const tabParam = params.get('tab');
  const tab: TabKey = isTabKey(tabParam) ? tabParam : DEFAULT_TAB;
  const q = params.get('q') ?? '';
  const paymentStatus = PAYMENT_OPTIONS.some((o) => o.value === params.get('paymentStatus')) ? params.get('paymentStatus')! : '';
  const shippingMethod = params.get('shippingMethod') ?? '';
  const day = (k: string) => { const v = params.get(k) ?? ''; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; };
  const from = day('from'), to = day('to');
  const [views, setViews] = useState<SavedView[]>(() => loadViews());
  const activeView = views.find((v) => v.id === params.get('view')) ?? null;
  const activeKey = activeView ? `view:${activeView.id}` : tab;
  const archived = tab === 'archived';

  const [page, setPage] = useState(1);
  const [selCode, setSelCode] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [cols, setCols] = useState<Cols>(() => loadCols());
  const [qInput, setQInput] = useState(q);
  const [exportOpen, setExportOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [fulfilCode, setFulfilCode] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  /** Patch URL params; filter/tab changes reset paging and selection. */
  function patch(p: Record<string, string | null>, keepView = false) {
    // Start from the live URL, not the hook's render-time params: React Router's updater does not queue, so the
    // debounced search would otherwise write a stale copy over a filter clicked in the meantime.
    setParams(() => {
      const n = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(p)) { if (v) n.set(k, v); else n.delete(k); }
      if (!keepView && !('view' in p)) n.delete('view');
      return n;
    }, { replace: true });
    setPage(1); setChecked(new Set()); setSelCode(null); setBulkResult(null);
  }

  // Debounced search -> ?q=
  useEffect(() => {
    if (qInput === q) return;
    const t = setTimeout(() => patch({ q: qInput.trim() || null }, true), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const counts = useQuery({
    queryKey: ['orders', 'tab-counts', store?.slug],
    queryFn: () => api.get<Record<string, number>>('/orders/tab-counts?excludeDemo=1'),
    enabled: !!store,
    refetchInterval: 60_000,
  });
  const shipMethods = useQuery({
    queryKey: ['shipping', store?.slug],
    queryFn: () => api.get<{ items: Array<{ code: string; name: string }> }>('/shipping-methods'),
    enabled: !!store, staleTime: 5 * 60_000,
  });
  const shipName = (code: string) => code === '__none__' ? 'None recorded' : shipMethods.data?.items.find((m) => m.code === code)?.name ?? code;

  const listQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (archived) p.set('trashed', '1'); else { p.set('excludeDemo', '1'); if (tab !== 'all') p.set('tab', tab); }
    if (q) p.set('q', q);
    if (paymentStatus) p.set('paymentStatus', paymentStatus);
    if (shippingMethod) p.set('shippingMethod', shippingMethod);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    p.set('page', String(page)); p.set('pageSize', String(PAGE_SIZE));
    return p.toString();
  }, [archived, tab, q, paymentStatus, shippingMethod, from, to, page]);

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['orders', store?.slug, listQuery],
    queryFn: () => api.get<Page<OrderRow>>(`/orders?${listQuery}`),
    placeholderData: keepPreviousData,
  });
  const items = data?.items ?? [];
  const selRow = items.find((o) => o.code === selCode) ?? null;

  const chipFilters: string[] = [];
  if (q) chipFilters.push(`Search is "${q}"`);
  if (paymentStatus) chipFilters.push(`Payment is ${paymentDef(paymentStatus).label}`);
  if (shippingMethod) chipFilters.push(`Shipping is ${shipName(shippingMethod)}`);
  if (from || to) chipFilters.push(`Placed ${from || '…'} to ${to || '…'}`);
  const dateInvalid = !!from && !!to && from > to;
  function clearFilters() { setQInput(''); patch({ q: null, paymentStatus: null, shippingMethod: null, from: null, to: null }); }

  // ---- selection / keyboard ----
  function select(code: string, focus = false) {
    setSelCode(code);
    if (focus) requestAnimationFrame(() => { const r = rowRefs.current.get(code); r?.focus(); r?.scrollIntoView({ block: 'nearest' }); });
  }
  function onRowKey(e: KeyboardEvent<HTMLTableRowElement>, o: OrderRow, i: number) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) select(next.code, true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) nav(`/orders/${encodeURIComponent(o.code)}`); else select(o.code);
    }
  }
  function onRootKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Escape' || !selCode || e.defaultPrevented) return;
    if (!e.currentTarget.contains(e.target as Node)) return; // dialogs render in portals
    const code = selCode;
    setSelCode(null);
    requestAnimationFrame(() => rowRefs.current.get(code)?.focus());
  }
  function onTabsKey(e: KeyboardEvent<HTMLDivElement>) {
    const btns = [...(tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role=tab]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % btns.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = btns.length - 1;
    if (n < 0) return;
    e.preventDefault();
    btns[n]!.focus(); btns[n]!.click();
  }

  // ---- saved views ----
  const [viewName, setViewName] = useState('');
  const viewErr = viewName ? validateViewName(viewName, views) : null;
  function saveView(close: () => void) {
    const err = validateViewName(viewName, views);
    if (err) return;
    const v: SavedView = { id: `v${Date.now()}`, name: viewName.trim(), tab, paymentStatus, shippingMethod, from, to };
    const next = [...views, v];
    setViews(next); storeViews(next); setViewName(''); close();
    patch({ view: v.id }, true);
    toast.success('View saved');
  }
  function openView(v: SavedView) {
    setQInput(q);
    patch({ tab: v.tab, view: v.id, paymentStatus: v.paymentStatus || null, shippingMethod: v.shippingMethod || null, from: v.from || null, to: v.to || null }, true);
  }
  function deleteView(v: SavedView) {
    const next = views.filter((x) => x.id !== v.id);
    setViews(next); storeViews(next);
    patch({ view: null }, true);
  }

  function toggleCol(k: ColKey) { const n = { ...cols, [k]: !cols[k] }; setCols(n); storeCols(n); }

  // ---- bulk ----
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['order', store?.slug] }); };
  function onBulkDone(verb: string) {
    return (r: BulkResult) => {
      const failed = r.results.filter((x) => !x.ok).length;
      if (failed === 0) toast.success(`${r.succeeded} order${r.succeeded === 1 ? '' : 's'} ${verb}`);
      else toast.error(`${r.succeeded} succeeded, ${failed} failed`, 'See the failure list for codes.');
      invalidate();
      setBulkResult(r);
      setChecked(new Set(r.results.filter((x) => !x.ok).map((x) => x.code)));
    };
  }
  const onBulkErr = (e: unknown) => { if ((e as Error).message === 'cancelled') return; toast.error('Bulk action failed', (e as Error).message); };
  const codes = () => [...checked];
  const bulkPost = (path: 'bulk-cancel' | 'bulk-soft-delete' | 'bulk-restore' | 'bulk-purge', extra?: Record<string, unknown>) =>
    api.post<BulkResult>(`/orders/${path}`, { codes: codes(), ...extra });
  const bulkFulfill = useMutation({
    mutationFn: async () => {
      const ok = await confirm({
        title: `Mark ${checked.size} orders as shipped?`,
        description: 'Each order is marked shipped without tracking details. Open one order to fulfil it with tracking.',
        confirmLabel: 'Mark shipped',
      });
      if (!ok) throw new Error('cancelled');
      return api.post<BulkResult>('/orders/bulk-fulfill', { orders: codes().map((code) => ({ code, state: 'Shipped' as const })) });
    },
    onSuccess: onBulkDone('marked shipped'), onError: onBulkErr,
  });
  const bulkCancel = useMutation({ mutationFn: () => bulkPost('bulk-cancel'), onSuccess: onBulkDone('cancelled'), onError: onBulkErr });
  const bulkTrash = useMutation({ mutationFn: () => bulkPost('bulk-soft-delete'), onSuccess: onBulkDone('moved to trash'), onError: onBulkErr });
  const bulkRestore = useMutation({ mutationFn: () => bulkPost('bulk-restore'), onSuccess: onBulkDone('restored'), onError: onBulkErr });
  const bulkPurge = useMutation({
    mutationFn: async () => {
      const paid = items.filter((o) => checked.has(o.code) && isPaidPurgeState(o.state)).map((o) => o.code);
      if (paid.length > 0) {
        const reason = await askForcePurge(checked.size, paid);
        if (reason === null) throw new Error('cancelled');
        return bulkPost('bulk-purge', { force: true, reason });
      }
      const ok = await confirm({ title: `Permanently delete ${checked.size} order${checked.size === 1 ? '' : 's'}?`, description: 'This cannot be undone.', tone: 'danger', confirmLabel: 'Delete permanently' });
      if (!ok) throw new Error('cancelled');
      return bulkPost('bulk-purge');
    },
    onSuccess: onBulkDone('purged'), onError: onBulkErr,
  });
  const busy = bulkFulfill.isPending || bulkCancel.isPending || bulkTrash.isPending || bulkRestore.isPending || bulkPurge.isPending;
  const selectedRows = items.filter((o) => checked.has(o.code));
  const allUnpaid = selectedRows.length === checked.size && selectedRows.every((o) => o.paymentStatus === 'pending');

  function exportSelectedCsv() {
    if (!selectedRows.length) return;
    const cell = (v: unknown) => {
      const raw = v == null ? '' : String(v);
      const s = /^[=+\-@|%]/.test(raw) ? `\t${raw}` : raw;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      ['code', 'date', 'email', 'paymentStatus', 'fulfilment', 'shippingMethod', 'preOrder', 'total', 'currency'].join(','),
      ...selectedRows.map((o) => [
        o.code, o.placedAt ?? o.createdAt, o.email ?? '', paymentDef(o.paymentStatus).label, fulfilmentPill(o).label,
        o.shippingMethodName ?? '', o.isPreOrder ? 'yes' : '', (o.grandTotal / 100).toFixed(2), o.currency,
      ].map(cell).join(',')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `orders-selected-${store?.slug ?? 'store'}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${selectedRows.length} selected order${selectedRows.length === 1 ? '' : 's'}`);
  }

  function startFulfil() {
    if (checked.size === 1) setFulfilCode([...checked][0]!); else bulkFulfill.mutate();
  }

  const exportFilters = { ...EMPTY_FILTERS, q, paymentStatus, from, to, status: tab === 'cancelled' ? 'cancelled' : archived ? 'archived' : '' };
  const total = data?.total ?? 0;
  const first = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = Math.min(page * PAGE_SIZE, total);
  const allChecked = items.length > 0 && items.every((o) => checked.has(o.code));
  const tabLabel = TABS.find((t) => t.key === tab)!.label;
  const allCount = counts.data?.all;
  const hasSel = checked.size > 0;
  const colClass = (['placed', 'items', 'payment', 'shipping'] as ColKey[]).filter((c) => !cols[c]).map((c) => `hide-${c}`).join(' ');

  return (
    <div className="rd" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} onKeyDown={onRootKey}>
      {confirmDialog}
      {forcePurgeDialog}
      <OrderExportDialog open={exportOpen} onClose={() => setExportOpen(false)} filters={exportFilters} />
      <AutoDeliverDialog open={deliverOpen} onClose={() => setDeliverOpen(false)} />
      {fulfilCode && (
        <FulfilDialog code={fulfilCode} open onClose={() => setFulfilCode(null)}
          onDone={() => { setFulfilCode(null); setChecked(new Set()); invalidate(); }} />
      )}

      <div className={`split${selRow ? ' open' : ''}`}>
        <div className="listcol">
          <div className="ph">
            <h1>Orders</h1>
            {allCount != null && <span className="meta mono">{allCount.toLocaleString()} orders</span>}
            <span className="sp" />
            <Popover align="right" trigger={({ open, toggle, id }) => (
              <button className="btn" aria-label="More order actions" aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}><Ellipsis size={16} aria-hidden="true" /></button>
            )}>
              {(close) => (
                <>
                  <Link to="/orders/import-tracking" className="btn ghost" style={{ display: 'flex', width: '100%', justifyContent: 'flex-start' }} onClick={close}>Import tracking (CSV)</Link>
                  <Link to="/orders/tracking-grid" className="btn ghost" style={{ display: 'flex', width: '100%', justifyContent: 'flex-start' }} onClick={close}>Add tracking to open orders</Link>
                  <button onClick={() => { close(); setDeliverOpen(true); }}>Mark old shipments delivered…</button>
                  <Link to="/abandoned-carts" className="btn ghost" style={{ display: 'flex', width: '100%', justifyContent: 'flex-start' }} onClick={close}>Abandoned carts</Link>
                </>
              )}
            </Popover>
            <button className="btn" onClick={() => setExportOpen(true)}><Download size={14} aria-hidden="true" />Export</button>
            <Link to="/orders/new" className="btn pri"><Plus size={14} aria-hidden="true" />New order</Link>
          </div>

          <div className="tabs" role="tablist" aria-label="Order views" ref={tablistRef} onKeyDown={onTabsKey}>
            {TABS.map((t) => {
              const sel = activeKey === t.key;
              const n = UNCOUNTED.has(t.key) ? undefined : counts.data?.[t.key];
              return (
                <button key={t.key} id={tabId(t.key)} className="tab" role="tab" aria-selected={sel} aria-controls={PANEL_ID} tabIndex={sel ? 0 : -1}
                  onClick={() => { setQInput(q); patch({ tab: t.key === DEFAULT_TAB ? null : t.key }, false); }}>
                  {t.label}{n != null && <> <b>{n.toLocaleString()}</b></>}
                </button>
              );
            })}
            {views.map((v) => {
              const sel = activeKey === `view:${v.id}`;
              return (
                <button key={v.id} id={tabId(`view-${v.id}`)} className="tab" role="tab" aria-selected={sel} aria-controls={PANEL_ID} tabIndex={sel ? 0 : -1} onClick={() => openView(v)}>{v.name}</button>
              );
            })}
          </div>

          {hasSel ? (
            <div className="bulk" role="toolbar" aria-label="Bulk actions">
              <span aria-live="polite">{checked.size} selected</span>
              <span className="sp" />
              {archived ? (
                <>
                  <button className="btn sm" onClick={() => bulkRestore.mutate()} disabled={busy}>Restore</button>
                  <button className="btn sm dng" onClick={() => bulkPurge.mutate()} disabled={busy}>Delete permanently</button>
                </>
              ) : (
                <>
                  <button className="btn sm" onClick={startFulfil} disabled={busy}>Fulfil</button>
                  <button className="btn sm" onClick={exportSelectedCsv} disabled={busy}>Export selected</button>
                  <button className="btn sm" onClick={() => bulkCancel.mutate()} disabled={busy || !allUnpaid} title={allUnpaid ? undefined : 'Only unpaid orders can be cancelled here'}>Cancel unpaid</button>
                  <button className="btn sm" onClick={() => bulkTrash.mutate()} disabled={busy}><Trash2 size={13} aria-hidden="true" />Move to trash</button>
                </>
              )}
              <button className="btn ghost sm" onClick={() => setChecked(new Set())}>Clear</button>
            </div>
          ) : (
            <div className="fbar">
              <label className="fsearch"><Search size={13} aria-hidden="true" />
                <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Order, name or email" aria-label="Filter orders" />
              </label>
              <FilterChip label="Payment" valueLabel={paymentStatus ? paymentDef(paymentStatus).label : null} onClear={() => patch({ paymentStatus: null })}>
                {(close) => PAYMENT_OPTIONS.map((o) => (
                  <button key={o.value} role="menuitemradio" aria-checked={o.value === paymentStatus} onClick={() => { patch({ paymentStatus: o.value }); close(); }}>{o.label}</button>
                ))}
              </FilterChip>
              <FilterChip label="Shipping" valueLabel={shippingMethod ? shipName(shippingMethod) : null} onClear={() => patch({ shippingMethod: null })}>
                {(close) => (
                  <>
                    {(shipMethods.data?.items ?? []).map((m) => (
                      <button key={m.code} role="menuitemradio" aria-checked={m.code === shippingMethod} onClick={() => { patch({ shippingMethod: m.code }); close(); }}>{m.name}</button>
                    ))}
                    <button role="menuitemradio" aria-checked={shippingMethod === '__none__'} onClick={() => { patch({ shippingMethod: '__none__' }); close(); }}>None recorded</button>
                    {shipMethods.isLoading && <div className="hint" style={{ padding: '4px 10px' }}>Loading methods…</div>}
                  </>
                )}
              </FilterChip>
              <FilterChip label="Date" valueLabel={from || to ? `${from || '…'} to ${to || '…'}` : null} onClear={() => patch({ from: null, to: null })}>
                {() => (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
                    <label className="hint">From <input type="date" aria-label="Date from" value={from} max={to || undefined} onChange={(e) => patch({ from: e.target.value || null })} /></label>
                    <label className="hint">To <input type="date" aria-label="Date to" value={to} min={from || undefined} onChange={(e) => patch({ to: e.target.value || null })} /></label>
                  </div>
                )}
              </FilterChip>
              <span className="sp" />
              {activeView && <button className="btn ghost sm" onClick={() => deleteView(activeView)}>Delete view</button>}
              <Popover align="right" trigger={({ open, toggle, id }) => (
                <button className="btn ghost sm" aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>Save view</button>
              )}>
                {(close) => (
                  <form style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, width: 240 }} onSubmit={(e) => { e.preventDefault(); saveView(close); }}>
                    <label className="hint" htmlFor="orders-view-name">View name</label>
                    <input id="orders-view-name" className="fsearch" style={{ width: '100%' }} autoFocus value={viewName} maxLength={40} aria-invalid={!!viewErr} aria-describedby="orders-view-err"
                      onChange={(e) => setViewName(e.target.value)} />
                    <div id="orders-view-err" className="err" role="alert">{viewErr}</div>
                    <div className="hint">Saves the current tab and filters (not the search).</div>
                    <button className="btn pri sm" type="submit" disabled={!viewName.trim() || !!viewErr}>Save view</button>
                  </form>
                )}
              </Popover>
              <Popover align="right" trigger={({ open, toggle, id }) => (
                <button className="btn sm" aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}><Columns3 size={14} aria-hidden="true" />Columns</button>
              )}>
                {() => (['placed', 'items', 'payment', 'shipping'] as ColKey[]).map((k) => (
                  <button key={k} role="menuitemcheckbox" aria-checked={cols[k]} onClick={() => toggleCol(k)}>
                    <input type="checkbox" className="cb" readOnly checked={cols[k]} tabIndex={-1} aria-hidden="true" />{COL_LABELS[k]}
                  </button>
                ))}
              </Popover>
            </div>
          )}

          {dateInvalid && <div className="note w" role="alert"><span>The start date is after the end date, so no orders can match.</span></div>}
          {error && <div style={{ padding: '8px 24px' }}><LoadError what="orders" detail={`${(error as Error).message} Your filters are kept.`} onRetry={() => refetch()} /></div>}
          {bulkResult && bulkResult.results.some((r) => !r.ok) && (
            <div className="banner w" role="alert" style={{ margin: '8px 24px' }}>
              <div>
                <b>{bulkResult.succeeded} succeeded, {bulkResult.skipped} skipped, {bulkResult.results.filter((r) => !r.ok).length} failed.</b>
                <ul>{bulkResult.results.filter((r) => !r.ok).map((r) => <li key={r.code}><span className="mono">{r.code}</span> — {r.error}</li>)}</ul>
              </div>
            </div>
          )}

          <div className="tscroll" id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(activeView ? `view-${activeView.id}` : tab)} aria-busy={isFetching}>
            {isLoading ? <LoadingRows label="Loading orders" /> : !data ? null : items.length === 0 ? (
              chipFilters.length > 0 ? <FilteredEmpty what="orders" filters={chipFilters} onClear={clearFilters} />
                : tab === 'all' && (counts.data?.all ?? 1) === 0 ? (
                  <EmptyState title="No orders yet" action={<Link to="/orders/new" className="btn pri"><Plus size={14} aria-hidden="true" />New order</Link>}>
                    Orders placed in your store appear here. You can also create one manually.
                  </EmptyState>
                ) : (
                  <EmptyState title={`No orders in ${tabLabel}`} icon={<Search size={18} aria-hidden="true" />}
                    action={tab === 'all' ? undefined : <button className="btn" onClick={() => patch({ tab: 'all' })}>Show all orders</button>} />
                )
            ) : (
              <table className={`rows ${colClass}`}>
                <thead>
                  <tr>
                    <th style={{ width: 38 }}>
                      <input type="checkbox" className="cb" aria-label="Select all orders in view" checked={allChecked}
                        onChange={() => setChecked(allChecked ? new Set() : new Set(items.map((o) => o.code)))} />
                    </th>
                    <th>Order</th>
                    <th data-col="placed">Placed</th>
                    <th>Customer</th>
                    <th className="hide-open" data-col="items">Items</th>
                    <th data-col="payment">Payment</th>
                    <th>Fulfilment</th>
                    <th data-col="shipping">Shipping</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((o, i) => {
                    const c = customerLabel(o);
                    const n = (o.openQty ?? 0) + (o.shippedQty ?? 0);
                    return (
                      <tr key={o.code} data-id={o.code} tabIndex={0} aria-selected={o.code === selCode}
                        ref={(el) => { if (el) rowRefs.current.set(o.code, el); else rowRefs.current.delete(o.code); }}
                        onClick={() => select(o.code)} onKeyDown={(e) => onRowKey(e, o, i)}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" className="cb" aria-label={`Select ${o.code}`} checked={checked.has(o.code)}
                            onChange={() => setChecked((cur) => { const s = new Set(cur); if (s.has(o.code)) s.delete(o.code); else s.add(o.code); return s; })} />
                        </td>
                        <td><Link to={`/orders/${encodeURIComponent(o.code)}`} className="lnk mono" tabIndex={-1} onClick={(e) => e.stopPropagation()}>{o.code}</Link></td>
                        <td className="muted" data-col="placed">{dateTime(o.placedAt ?? o.createdAt)}</td>
                        <td>{c.name ?? c.email ?? '—'}</td>
                        <td className="muted hide-open" data-col="items">{o.openQty == null ? '—' : `${n} item${n === 1 ? '' : 's'}`}</td>
                        <td data-col="payment"><PillView pill={paymentPill(o.paymentStatus)} /></td>
                        <td><PillView pill={fulfilmentPill(o)} /></td>
                        <td className="muted" data-col="shipping">{o.shippingMethodName ?? '—'}</td>
                        <td className="num">{money(o.grandTotal, o.currency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="foot">
            <span>{total ? `${first}–${last} of ${total.toLocaleString()}` : '0 orders'}</span>
            <span className="sp" />
            <span className="muted">↑ ↓ to move · Enter to open · Shift+Enter for the full page</span>
            <button className="btn sm" aria-label="Previous page" disabled={page <= 1} onClick={() => { setPage(page - 1); setChecked(new Set()); setSelCode(null); }}><ChevronLeft size={14} aria-hidden="true" /></button>
            <button className="btn sm" aria-label="Next page" disabled={last >= total} onClick={() => { setPage(page + 1); setChecked(new Set()); setSelCode(null); }}><ChevronRight size={14} aria-hidden="true" /></button>
          </div>
        </div>

        {selRow && <OrderInspector row={selRow} onClose={() => setSelCode(null)} onFulfil={setFulfilCode} />}
      </div>
    </div>
  );
}
