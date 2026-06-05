import { useState } from 'react';
import { useQuery, keepPreviousData, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Plus } from 'lucide-react';
import { api, type Page, type CustomerRow } from '../api';
import { useAuth } from '../auth';
import { money, date, initials } from '../lib/format';
import { Loading, ErrorNote, PageHeader, EmptyState, Pagination, Spinner } from '../components/ui';

export default function Customers() {
  const { store } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const cur = store?.currency ?? 'USD';
  const [form, setForm] = useState<{ email: string; firstName: string; lastName: string } | null>(null);

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['customers', store?.slug, q, page],
    queryFn: () => api.get<Page<CustomerRow>>(`/customers?${new URLSearchParams({ q, page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/customers', { email: form!.email, firstName: form!.firstName || undefined, lastName: form!.lastName || undefined }),
    onSuccess: (r) => { setForm(null); qc.invalidateQueries({ queryKey: ['customers', store?.slug] }); nav(`/customers/${r.id}`); },
  });
  const name = (c: CustomerRow) => [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';

  return (
    <>
      <PageHeader title="Customers" subtitle={data ? `${data.total} total` : undefined} actions={
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pl-9 w-56" placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          <button className="btn-primary whitespace-nowrap" onClick={() => setForm(form ? null : { email: '', firstName: '', lastName: '' })}><Plus size={16} /> New customer</button>
        </div>
      } />

      {form && (
        <form className="card p-4 mb-4 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="flex-1 min-w-[12rem]"><label className="label">Email</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
          <div><label className="label">First</label><input className="input w-28" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></div>
          <div><label className="label">Last</label><input className="input w-28" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></div>
          <button className="btn-primary" disabled={create.isPending || !form.email.trim()}>{create.isPending ? <Spinner className="text-white" /> : 'Create'}</button>
        </form>
      )}
      {create.error && <div className="mb-4"><ErrorNote message={(create.error as Error).message} /></div>}

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

      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
