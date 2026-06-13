import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Plus, Download, Upload, ShoppingCart, ShoppingBag } from 'lucide-react';
import { api, downloadFile, type Page, type OrderRow } from '../api';
import { useAuth } from '../auth';
import { money, dateTime } from '../lib/format';
import {
  Badge, PageHeader, Pagination, Tabs, ResourceToolbar, SearchInput, ResourceTable,
  ActionMenu, EmptyStateActionPanel, type Column, type TabDef,
} from '../components/ui';

const TABS: (TabDef & { pre?: boolean })[] = [
  { key: '', label: 'All' },
  { key: 'PendingPayment', label: 'Pending' },
  { key: 'Paid', label: 'Paid' },
  { key: 'preorder', label: 'Pre-orders', pre: true },
  { key: 'Cancelled', label: 'Cancelled' },
  { key: 'Refunded', label: 'Refunded' },
];

export default function Orders() {
  const { store } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const s = params.get('state') ?? '';
    return TABS.some((t) => t.key === s) ? s : '';
  });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const isPre = tab === 'preorder';
  const state = isPre ? '' : tab;

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['orders', store?.slug, tab, q, page],
    queryFn: () => api.get<Page<OrderRow>>(`/orders?${new URLSearchParams({ state, q, preOrder: isPre ? '1' : '', page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });

  async function exportCsv() {
    setExporting(true);
    try { await downloadFile(`/export/orders?days=365${state ? `&state=${state}` : ''}`, `orders-${store?.slug ?? 'store'}.csv`); }
    finally { setExporting(false); }
  }

  const columns: Column<OrderRow>[] = [
    { key: 'code', header: 'Order', width: '20%', render: (o) => (
      <span className="font-medium">{o.code}{o.isPreOrder && <span className="ml-1.5 align-middle text-[10px] uppercase font-semibold text-amber-600 bg-amber-50 rounded px-1 py-0.5">pre-order</span>}</span>
    )},
    { key: 'date', header: 'Date', width: '22%', render: (o) => <span className="text-gray-500">{dateTime(o.placedAt ?? o.createdAt)}</span> },
    { key: 'customer', header: 'Customer', render: (o) => <span className="text-gray-600 truncate block">{o.email ?? '—'}</span> },
    { key: 'status', header: 'Payment', width: '16%', render: (o) => <Badge value={o.state} /> },
    { key: 'total', header: 'Total', align: 'right', width: '15%', render: (o) => <span className="font-medium tnum">{money(o.grandTotal, o.currency)}</span> },
  ];

  const isFiltered = !!q || !!tab;

  return (
    <>
      <PageHeader title="Orders" subtitle={data ? `${data.total} total` : undefined} actions={
        <div className="flex items-center gap-2">
          <ActionMenu label="Actions" items={[
            { label: exporting ? 'Exporting…' : 'Export CSV', icon: <Download size={15} />, onClick: exportCsv, disabled: exporting },
            { label: 'Import tracking', icon: <Upload size={15} />, to: '/orders/import-tracking' },
            { label: 'Abandoned carts', icon: <ShoppingCart size={15} />, to: '/abandoned-carts' },
          ]} />
          <Link to="/orders/new" className="btn-primary whitespace-nowrap"><Plus size={16} /> New order</Link>
        </div>
      } />

      <ResourceToolbar
        left={<Tabs tabs={TABS} value={tab} onChange={(k) => { setTab(k); setPage(1); }} />}
        right={<SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search code or email" />}
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
        empty={isFiltered
          ? <EmptyStateActionPanel icon={<ShoppingBag size={22} />} title="No matching orders" description="No orders match this filter or search. Try clearing it." actions={[{ label: 'Clear filters', variant: 'ghost', onClick: () => { setTab(''); setQ(''); setPage(1); } }]} />
          : <EmptyStateActionPanel icon={<ShoppingBag size={22} />} title="No orders yet" description="Orders placed in your store will appear here. You can also create an order manually." actions={[{ label: 'New order', to: '/orders/new', icon: <Plus size={16} /> }]} />}
      />

      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
