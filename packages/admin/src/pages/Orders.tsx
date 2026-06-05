import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { Search, Plus, Download, Upload } from 'lucide-react';
import { api, downloadFile, type Page, type OrderRow } from '../api';
import { useAuth } from '../auth';
import { money, dateTime } from '../lib/format';
import { Badge, Loading, ErrorNote, PageHeader, EmptyState, Pagination } from '../components/ui';

const TABS = [
  { key: '', label: 'All', pre: false },
  { key: 'PendingPayment', label: 'Pending', pre: false },
  { key: 'Paid', label: 'Paid', pre: false },
  { key: 'preorder', label: 'Pre-orders', pre: true },
  { key: 'Cancelled', label: 'Cancelled', pre: false },
  { key: 'Refunded', label: 'Refunded', pre: false },
];

export default function Orders() {
  const { store } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const isPre = tab === 'preorder';
  const state = isPre ? '' : tab;

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['orders', store?.slug, tab, q, page],
    queryFn: () => api.get<Page<OrderRow>>(`/orders?${new URLSearchParams({ state, q, preOrder: isPre ? '1' : '', page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });

  async function exportCsv() {
    setExporting(true);
    try { await downloadFile(`/export/orders?days=365${state ? `&state=${state}` : ''}`, `orders-${store?.slug ?? 'store'}.csv`); }
    finally { setExporting(false); }
  }

  return (
    <>
      <PageHeader title="Orders" subtitle={data ? `${data.total} total` : undefined} actions={
        <div className="flex items-center gap-2">
          <button className="btn-ghost whitespace-nowrap" disabled={exporting} onClick={exportCsv}><Download size={15} /> {exporting ? 'Exporting…' : 'Export'}</button>
          <Link to="/orders/import-tracking" className="btn-ghost whitespace-nowrap"><Upload size={15} /> Import tracking</Link>
          <Link to="/abandoned-carts" className="btn-ghost whitespace-nowrap">Abandoned carts</Link>
          <Link to="/orders/new" className="btn-primary whitespace-nowrap"><Plus size={16} /> New order</Link>
        </div>
      } />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => { setTab(t.key); setPage(1); }}
              className={`px-3 py-1.5 text-sm rounded-md ${tab === t.key ? 'bg-brand-light text-brand font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pl-9 w-64" placeholder="Search code or email" value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? (
          <EmptyState title="No orders" hint="Try a different filter or search." />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Order</th><th className="th">Date</th><th className="th">Customer</th><th className="th">Status</th><th className="th text-right">Total</th>
            </tr></thead>
            <tbody className={isFetching ? 'opacity-60' : ''}>
              {data.items.map((o) => (
                <tr key={o.code} className="row-link" onClick={() => nav(`/orders/${o.code}`)}>
                  <td className="td font-medium">{o.code} {o.isPreOrder && <span className="ml-1 text-[10px] uppercase font-semibold text-amber-600 bg-amber-50 rounded px-1 py-0.5">pre-order</span>}</td>
                  <td className="td text-gray-500">{dateTime(o.placedAt ?? o.createdAt)}</td>
                  <td className="td text-gray-600">{o.email ?? '—'}</td>
                  <td className="td"><Badge value={o.state} /></td>
                  <td className="td text-right font-medium">{money(o.grandTotal, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
