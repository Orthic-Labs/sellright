import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ArrowLeft, FileUp } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { date } from '../lib/format';
import { PageHeader, SearchInput, Spinner, InlineAlert, Badge, ErrorState } from '../components/ui';
import { CARRIER_OPTIONS, inferCarrier } from '../lib/carrier';
import { STATUS_LABEL, inputKey, isImportable, itemsSummary, type ImportResponse, type PreviewResponse, type PreviewRow } from '../lib/tracking';

interface OpenOrder {
  code: string; placedAt: string; isPreOrder: boolean; email: string | null; name: string | null; country: string | null;
  fulfillmentStatus: string; items: { sku: string; name: string; quantity: number }[]; shippedTracking: string[];
}
interface Entry { tracking: string; carrier: string }

/** Manual tracking grid: every paid order still to ship, paste tracking per row, dry run, then confirm. */
export default function TrackingGrid() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [notify, setNotify] = useState(true);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const open = useQuery({
    queryKey: ['open-orders', store?.slug, q],
    queryFn: () => api.get<{ items: OpenOrder[]; total: number }>(`/fulfillment/open-orders?${new URLSearchParams({ q, limit: '200' })}`),
    placeholderData: keepPreviousData,
  });
  const orders = open.data?.items ?? [];

  const filled = useMemo(() => Object.entries(entries).filter(([, e]) => e.tracking.trim()).map(([code, e]) => ({ code, tracking: e.tracking, carrier: e.carrier || null })), [entries]);
  const key = inputKey(filled, notify);
  const stale = !!preview && key !== previewKey;
  const verdicts = useMemo(() => new Map((preview?.rows ?? []).map((r) => [r.code, r])), [preview]);
  const ready = (preview?.rows ?? []).filter((r) => isImportable(r.status));

  const dryRun = useMutation({
    mutationFn: () => api.post<PreviewResponse>('/import-tracking/preview', { rows: filled }),
    onSuccess: (r) => { setPreview(r); setPreviewKey(key); setResult(null); setErr(null); },
    onError: (e) => setErr((e as Error).message),
  });
  const confirm = useMutation({
    mutationFn: () => api.post<ImportResponse>('/import-tracking', { rows: filled, notify, source: 'grid' }),
    onSuccess: (r) => {
      setResult(r); setPreview(null); setErr(null);
      // Clear the rows that shipped; keep the rest so they can be fixed and retried.
      const done = new Set(r.rows.filter((x) => x.imported).map((x) => x.code));
      setEntries((cur) => Object.fromEntries(Object.entries(cur).filter(([code]) => !done.has(code.toUpperCase()))));
      void qc.invalidateQueries({ queryKey: ['open-orders', store?.slug] });
      void qc.invalidateQueries({ queryKey: ['orders', store?.slug] });
      void qc.invalidateQueries({ queryKey: ['tracking-imports', store?.slug] });
    },
    onError: (e) => setErr((e as Error).message),
  });

  const setEntry = (code: string, patch: Partial<Entry>) => setEntries((cur) => ({ ...cur, [code]: { ...{ tracking: '', carrier: '' }, ...cur[code], ...patch } }));

  // Pasting a column of numbers (e.g. from a spreadsheet) fills downward from this row.
  function onPaste(i: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const lines = e.clipboardData.getData('text').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    setEntries((cur) => {
      const next = { ...cur };
      lines.forEach((tracking, k) => { const o = orders[i + k]; if (o) next[o.code] = { ...{ tracking: '', carrier: '' }, ...next[o.code], tracking: tracking.split(/[\t,]/)[0]!.trim() }; });
      return next;
    });
  }

  return (
    <>
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Orders</Link>
      <PageHeader title="Add tracking to open orders" subtitle={open.data ? `${open.data.total} paid order${open.data.total === 1 ? '' : 's'} waiting to ship, oldest first.` : 'Paid orders waiting to ship, oldest first.'} actions={
        <Link to="/orders/import-tracking" className="btn-ghost whitespace-nowrap"><FileUp size={15} /> Import a CSV instead</Link>
      } />
      {err && <div className="mb-3"><InlineAlert tone="critical">{err}</InlineAlert></div>}
      {result && (
        <div className="mb-3"><InlineAlert tone={result.skipped ? 'attention' : 'positive'} title={`${result.updated} order${result.updated === 1 ? '' : 's'} marked shipped, ${result.emailsQueued} email${result.emailsQueued === 1 ? '' : 's'} queued.`}>
          {result.skipped > 0 && <ul className="text-xs mt-1">{result.errors.slice(0, 10).map((e, i) => <li key={i}><span className="font-mono">{e.code}</span> — {e.error}</li>)}</ul>}
        </InlineAlert></div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search order or email" />
        <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email customers</label>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">{filled.length} row{filled.length === 1 ? '' : 's'} filled</span>
          <button className="btn-ghost" disabled={filled.length === 0 || dryRun.isPending || confirm.isPending} onClick={() => dryRun.mutate()}>{dryRun.isPending ? <Spinner /> : preview && !stale ? 'Dry run again' : 'Dry run'}</button>
          <button className="btn-primary" disabled={!preview || stale || ready.length === 0 || confirm.isPending} onClick={() => confirm.mutate()}>{confirm.isPending ? <Spinner className="text-white" /> : `Confirm and ship ${ready.length}`}</button>
        </span>
      </div>
      {stale && <div className="mb-3"><InlineAlert tone="attention">You changed rows after the dry run. Run it again before confirming.</InlineAlert></div>}

      {open.error ? <div className="card"><ErrorState message={(open.error as Error).message} onRetry={() => open.refetch()} /></div> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: '60rem' }}>
            <thead>
              <tr>
                <th className="th text-left w-[14%]">Order</th>
                <th className="th text-left w-[18%]">Customer</th>
                <th className="th text-left w-[20%]">Still to ship</th>
                <th className="th text-left w-[22%]">Tracking number</th>
                <th className="th text-left w-[12%]">Carrier</th>
                <th className="th text-left">Dry run</th>
              </tr>
            </thead>
            <tbody className={open.isFetching ? 'opacity-60' : ''}>
              {orders.map((o, i) => {
                const e = entries[o.code]; const detected = e?.tracking ? inferCarrier(e.tracking) : null;
                const v: PreviewRow | undefined = stale ? undefined : verdicts.get(o.code);
                return (
                  <tr key={o.code}>
                    <td className="td"><span className="font-medium">{o.code}</span>
                      <div className="text-xs text-gray-400">{date(o.placedAt)}{o.isPreOrder && <span className="ml-1 text-warning">pre-order</span>}</div></td>
                    <td className="td min-w-0"><div className="truncate">{o.name ?? o.email ?? '—'}</div>{o.name && o.email && <div className="truncate text-xs text-gray-500">{o.email}</div>}{o.country && <div className="text-xs text-gray-400">{o.country}</div>}</td>
                    <td className="td text-xs">
                      {o.items.length ? o.items.map((it) => <div key={it.sku} title={it.name}>{it.quantity}× {it.sku}</div>) : <span className="text-gray-400">—</span>}
                      {o.fulfillmentStatus === 'partially_fulfilled' && <div className="text-info mt-0.5">partly shipped{o.shippedTracking.length ? `: ${o.shippedTracking.join(', ')}` : ''}</div>}
                    </td>
                    <td className="td"><input className="input !py-1.5 font-mono !text-xs" aria-label={`Tracking number for ${o.code}`} value={e?.tracking ?? ''} placeholder="Paste tracking" onChange={(ev) => setEntry(o.code, { tracking: ev.target.value })} onPaste={(ev) => onPaste(i, ev)} /></td>
                    <td className="td">
                      <select className="input !py-1.5 !text-xs" aria-label={`Carrier for ${o.code}`} value={e?.carrier ?? ''} onChange={(ev) => setEntry(o.code, { carrier: ev.target.value })}>
                        <option value="">{detected ? `Auto: ${detected}` : 'Auto'}</option>
                        {CARRIER_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className="td text-xs">
                      {v ? <><Badge value={v.status} tone={STATUS_LABEL[v.status].tone} label={STATUS_LABEL[v.status].label} />
                        <div className="text-gray-500 mt-0.5">{isImportable(v.status) && v.items.length ? `Ships ${itemsSummary(v.items)}` : v.message}{isImportable(v.status) && notify && v.customerEmail ? ' · emails customer' : ''}</div></>
                        : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                );
              })}
              {!open.isLoading && orders.length === 0 && <tr><td className="td text-gray-400 py-8 text-center" colSpan={6}>{q ? 'No open orders match your search.' : 'Nothing is waiting to ship.'}</td></tr>}
              {open.isLoading && <tr><td className="td text-gray-400" colSpan={6}><Spinner /> Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {open.data && open.data.total > orders.length && <p className="text-xs text-gray-400 mt-2">Showing the oldest {orders.length} of {open.data.total}. Ship these, or search for a specific order.</p>}
    </>
  );
}
