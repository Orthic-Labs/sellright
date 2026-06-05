import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, type Page } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Pagination, Badge } from '../components/ui';
import { dateTime } from '../lib/format';

interface CartRow { token: string; status: string; updatedAt: string; email: string | null; items: number; }

export default function AbandonedCarts() {
  const { store } = useAuth();
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ['abandoned', store?.slug, page],
    queryFn: () => api.get<Page<CartRow>>(`/abandoned-carts?page=${page}&pageSize=25`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Abandoned carts" subtitle="Carts with items that never became an order." />
      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? <EmptyState title="No abandoned carts" /> : (
          <table className="w-full">
            <thead><tr><th className="th">Customer</th><th className="th text-center">Items</th><th className="th">Status</th><th className="th">Last activity</th></tr></thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.token} className="border-t border-gray-100">
                  <td className="td">{c.email ?? <span className="text-gray-400">Guest</span>}</td>
                  <td className="td text-center text-gray-600">{c.items}</td>
                  <td className="td"><Badge value={c.status} /></td>
                  <td className="td text-gray-500">{dateTime(c.updatedAt)}</td>
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
