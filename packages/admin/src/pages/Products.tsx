import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Package, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, assetUrl, type Page, type ProductRow } from '../api';
import { useAuth } from '../auth';
import { money } from '../lib/format';
import { Badge, Loading, ErrorNote, PageHeader, EmptyState, Pagination } from '../components/ui';

export default function Products() {
  const { store } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const cur = store?.currency ?? 'USD';

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['products', store?.slug, q, page],
    queryFn: () => api.get<Page<ProductRow>>(`/products?${new URLSearchParams({ q, page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Products" subtitle={data ? `${data.total} total` : undefined} actions={
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pl-9 w-56" placeholder="Search products" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          <Link to="/products/new" className="btn-primary whitespace-nowrap"><Plus size={16} /> New product</Link>
        </div>
      } />

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? (
          <EmptyState title="No products" />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Product</th><th className="th">Status</th><th className="th text-center">Variants</th><th className="th text-right">From</th><th className="th text-right">Stock</th>
            </tr></thead>
            <tbody className={isFetching ? 'opacity-60' : ''}>
              {data.items.map((p) => {
                const img = assetUrl(p.assetPath);
                return (
                  <tr key={p.id} className="row-link" onClick={() => nav(`/products/${p.id}`)}>
                    <td className="td">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-gray-100 grid place-items-center overflow-hidden shrink-0">
                          {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : <Package size={16} className="text-gray-400" />}
                        </div>
                        <span className="font-medium">{p.name}</span>
                      </div>
                    </td>
                    <td className="td"><Badge value={p.status} /></td>
                    <td className="td text-center text-gray-500">{p.variants}</td>
                    <td className="td text-right">{p.minPrice != null ? money(p.minPrice, cur) : '—'}</td>
                    <td className="td text-right">
                      <span className={p.stock <= 3 ? 'text-amber-600 font-medium' : 'text-gray-600'}>{p.stock}</span>
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
