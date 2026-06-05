import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api, type Page, type CustomerRow } from '../api';
import { useAuth } from '../auth';
import { money, date, initials } from '../lib/format';
import { Loading, ErrorNote, PageHeader, EmptyState } from '../components/ui';

export default function Customers() {
  const { store } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const cur = store?.currency ?? 'USD';

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['customers', store?.slug, q, page],
    queryFn: () => api.get<Page<CustomerRow>>(`/customers?${new URLSearchParams({ q, page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const name = (c: CustomerRow) => [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';

  return (
    <>
      <PageHeader title="Customers" subtitle={data ? `${data.total} total` : undefined} actions={
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pl-9 w-64" placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
      } />

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? (
          <EmptyState title="No customers" />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Customer</th><th className="th">Email</th><th className="th text-center">Orders</th><th className="th text-right">Spent</th><th className="th">Joined</th>
            </tr></thead>
            <tbody className={isFetching ? 'opacity-60' : ''}>
              {data.items.map((c) => (
                <tr key={c.id} className="row-link" onClick={() => nav(`/customers/${c.id}`)}>
                  <td className="td">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-brand-light text-brand grid place-items-center text-xs font-semibold shrink-0">{initials(c.email, c.firstName, c.lastName)}</div>
                      <span className="font-medium">{name(c)}</span>
                    </div>
                  </td>
                  <td className="td text-gray-600">{c.email}</td>
                  <td className="td text-center text-gray-500">{c.orders}</td>
                  <td className="td text-right font-medium">{money(c.spent, cur)}</td>
                  <td className="td text-gray-500">{date(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <button className="btn-ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </div>
      )}
    </>
  );
}
