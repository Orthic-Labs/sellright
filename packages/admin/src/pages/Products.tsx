import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { Package, Plus, Layers } from 'lucide-react';
import { api, assetUrl, type Page, type ProductRow } from '../api';
import { useAuth } from '../auth';
import { money } from '../lib/format';
import {
  Badge, PageHeader, Pagination, Tabs, ResourceToolbar, SearchInput, ResourceTable,
  EmptyStateActionPanel, type Column, type TabDef,
} from '../components/ui';

const STATUS_TABS: TabDef[] = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'draft', label: 'Draft' },
];

export default function Products() {
  const { store } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const cur = store?.currency ?? 'USD';

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['products', store?.slug, q, status, page],
    queryFn: () => api.get<Page<ProductRow>>(`/products?${new URLSearchParams({ q, status, page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });

  const columns: Column<ProductRow>[] = [
    { key: 'product', header: 'Product', render: (p) => {
      const img = assetUrl(p.assetPath);
      return (
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-lg bg-gray-100 grid place-items-center overflow-hidden shrink-0">
            {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : <Package size={16} className="text-gray-400" />}
          </div>
          <span className="font-medium truncate">{p.name}</span>
        </div>
      );
    }},
    { key: 'status', header: 'Status', width: '12%', render: (p) => <Badge value={p.status} /> },
    { key: 'variants', header: 'Variants', align: 'center', width: '12%', render: (p) => <span className="tnum text-gray-500">{p.variants}</span> },
    { key: 'price', header: 'From', align: 'right', width: '15%', render: (p) => <span className="tnum">{p.minPrice != null ? money(p.minPrice, cur) : '—'}</span> },
    { key: 'stock', header: 'Stock', align: 'right', width: '12%', render: (p) => <span className={`tnum ${p.stock <= 3 ? 'text-amber-600 font-medium' : 'text-gray-600'}`}>{p.stock}</span> },
  ];

  const isFiltered = !!q || !!status;

  return (
    <>
      <PageHeader title="Products" subtitle={data ? `${data.total} total` : undefined} actions={
        <Link to="/products/new" className="btn-primary whitespace-nowrap"><Plus size={16} /> New product</Link>
      } />

      <ResourceToolbar
        left={<Tabs tabs={STATUS_TABS} value={status} onChange={(k) => { setStatus(k); setPage(1); }} />}
        right={<SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search products" className="w-56" />}
      />

      <ResourceTable
        columns={columns}
        rows={data?.items}
        rowKey={(p) => p.id}
        onRowClick={(p) => nav(`/products/${p.id}`)}
        loading={isLoading}
        isFetching={isFetching}
        error={error ? (error as Error).message : null}
        onRetry={() => refetch()}
        empty={isFiltered
          ? <EmptyStateActionPanel icon={<Package size={22} />} title="No matching products" description="No products match this filter or search." actions={[{ label: 'Clear filters', variant: 'ghost', onClick: () => { setStatus(''); setQ(''); setPage(1); } }]} />
          : <EmptyStateActionPanel icon={<Package size={22} />} title="Add your first product" description="Create a product to start selling, or organize products into collections." actions={[
              { label: 'Add product', to: '/products/new', icon: <Plus size={16} /> },
              { label: 'Create collection', variant: 'ghost', to: '/collections', icon: <Layers size={15} /> },
            ]} />}
      />

      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
