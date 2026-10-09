import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ChevronDown, ChevronUp } from 'lucide-react';
import { api, downloadFile } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { dateTime } from '../lib/format';
import { RANGE_LABELS, rangeFor, type RangePreset } from '../lib/export-presets';
import { nextSort, waitlistQuery, type SortDir, type WaitlistGroup, type WaitlistSort } from '../lib/waitlist';
import { EmptyState, ErrorState, Field, InlineAlert, KpiCard, Loading, PageHeader, Spinner } from '../components/ui';

interface Row {
  key: string; productName: string; productSlug: string | null; variantName: string | null; sku: string | null; available: number | null; variants: number;
  pending: number; notified: number; canceled: number; unconfirmed: number; legacyClosed: number; total: number; lastSignupAt: string | null; oldestPendingAt: string | null;
}
interface Report {
  groupBy: WaitlistGroup; range: { from: string | null; to: string | null }; truncated: boolean;
  summary: { pending: number; notified: number; canceled: number; unconfirmed: number; legacyClosed: number; total: number; products: number; variants: number };
  rows: Row[];
}

const PRESETS: RangePreset[] = ['all', 'last30', 'last90', 'thisYear', 'custom'];

export default function WaitlistPage() {
  const { store } = useAuth();
  const toast = useToast();
  const [preset, setPreset] = useState<RangePreset>('all');
  const [{ from, to }, setRange] = useState({ from: '', to: '' });
  const [groupBy, setGroupBy] = useState<WaitlistGroup>('variant');
  const [order, setOrder] = useState<{ sort: WaitlistSort; dir: SortDir }>({ sort: 'pending', dir: 'desc' });
  const [busy, setBusy] = useState(false);

  const invalid = !!from && !!to && from > to;
  const qs = waitlistQuery({ from, to, groupBy, ...order });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['waitlist', store?.slug, qs], queryFn: () => api.get<Report>(`/waitlist/report?${qs}`), enabled: !invalid, staleTime: 0, gcTime: 0 });

  const pick = (p: RangePreset) => { setPreset(p); if (p === 'all') setRange({ from: '', to: '' }); else if (p !== 'custom') setRange(rangeFor(p)); };
  async function download() {
    setBusy(true);
    try { await downloadFile(`/waitlist/report.csv?${qs}`, `waitlist-demand-${store?.slug ?? 'store'}-${groupBy}.csv`); toast.success('Download started'); }
    catch (e) { toast.error('Download failed', (e as Error).message); }
    finally { setBusy(false); }
  }

  const Th = ({ col, label, right }: { col: WaitlistSort; label: string; right?: boolean }) => {
    const active = order.sort === col;
    return (
      <th className={`th ${right ? 'text-right' : ''}`} aria-sort={active ? (order.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className={`inline-flex items-center gap-1 ${active ? 'text-ink' : ''}`} onClick={() => setOrder((o) => nextSort(o, col))}>
          {label}{active && (order.dir === 'asc' ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />)}
        </button>
      </th>
    );
  };

  const productMode = groupBy === 'product';
  return (
    <>
      <PageHeader title="Waitlist demand" subtitle="Shoppers waiting for out-of-stock items, and how many were already notified"
        actions={<button className="btn-ghost" disabled={busy || invalid || !data?.rows.length} onClick={download}>{busy ? <Spinner /> : <Download size={15} />} Download CSV</button>} />

      <div className="card p-4 mb-5 grid sm:grid-cols-4 gap-3">
        <Field label="Signed up" htmlFor="wl-range">
          <select id="wl-range" className="input" value={preset} onChange={(e) => pick(e.target.value as RangePreset)}>
            {PRESETS.map((k) => <option key={k} value={k}>{k === 'all' ? 'All time' : RANGE_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="From" htmlFor="wl-from"><input id="wl-from" type="date" className="input" value={from} onChange={(e) => { setPreset('custom'); setRange({ from: e.target.value, to }); }} /></Field>
        <Field label="To" htmlFor="wl-to" error={invalid ? 'From must be on or before To' : undefined}><input id="wl-to" type="date" className="input" value={to} onChange={(e) => { setPreset('custom'); setRange({ from, to: e.target.value }); }} /></Field>
        <Field label="Group by" htmlFor="wl-group">
          <select id="wl-group" className="input" value={groupBy} onChange={(e) => { setGroupBy(e.target.value as WaitlistGroup); setOrder({ sort: 'pending', dir: 'desc' }); }}>
            <option value="variant">Variant</option><option value="product">Product</option>
          </select>
        </Field>
      </div>

      {isLoading && !invalid ? <Loading /> : error ? <div className="card overflow-hidden"><ErrorState message={(error as Error).message} onRetry={() => refetch()} /></div> : data && !invalid && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <KpiCard label="Waiting now" value={<span className="tnum">{data.summary.pending}</span>} hint={`${data.summary.variants} variant${data.summary.variants === 1 ? '' : 's'} · ${data.summary.products} product${data.summary.products === 1 ? '' : 's'}`} />
            <KpiCard label="Notified" value={<span className="tnum">{data.summary.notified}</span>} />
            <KpiCard label="Canceled" value={<span className="tnum">{data.summary.canceled}</span>} />
            <KpiCard label="Total signups" value={<span className="tnum">{data.summary.total}</span>} hint={data.summary.unconfirmed ? `${data.summary.unconfirmed} not yet confirmed` : undefined} />
          </div>
          {data.truncated && <div className="mb-4"><InlineAlert tone="attention">Showing the 5,000 variants with the most demand. Narrow the date range to see the rest.</InlineAlert></div>}
          <div className="card overflow-x-auto">
            {data.rows.length === 0 ? <EmptyState title="No waitlist signups" hint="Signups appear when shoppers ask to be notified about an out-of-stock item." /> : (
              <table className="w-full">
                <thead><tr>
                  <Th col="product" label="Product" />
                  {productMode ? <th className="th text-right">Variants</th> : <Th col="variant" label="Variant" />}
                  <Th col="pending" label="Waiting" right /><Th col="notified" label="Notified" right /><Th col="canceled" label="Canceled" right /><Th col="total" label="Total" right />
                  <Th col="available" label="In stock" right /><Th col="oldestPending" label="Oldest waiting" /><Th col="lastSignup" label="Latest signup" />
                </tr></thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.key} className="border-t border-gray-100">
                      <td className="td font-medium">{r.productName}</td>
                      <td className={productMode ? 'td text-right tnum' : 'td'}>{productMode ? r.variants : <>{r.variantName}{r.sku && <span className="ml-2 font-mono text-xs text-gray-400">{r.sku}</span>}</>}</td>
                      <td className="td text-right font-medium tnum">{r.pending}</td>
                      <td className="td text-right tnum">{r.notified}</td>
                      <td className="td text-right tnum">{r.canceled}</td>
                      <td className="td text-right tnum">{r.total}</td>
                      <td className="td text-right tnum">{r.available === null ? '—' : r.available <= 0 ? <span className="text-warning">out</span> : r.available}</td>
                      <td className="td text-gray-500">{dateTime(r.oldestPendingAt)}</td>
                      <td className="td text-gray-500">{dateTime(r.lastSignupAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {(data.summary.legacyClosed > 0 || data.summary.unconfirmed > 0) && (
            <p className="mt-3 text-xs text-gray-500">
              Totals also include older waitlist signups: {data.summary.unconfirmed} not yet confirmed by email and {data.summary.legacyClosed} already notified or unsubscribed (those two cannot be told apart).
            </p>
          )}
        </>
      )}
    </>
  );
}
