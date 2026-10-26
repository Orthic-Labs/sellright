import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Spinner, Badge, SearchInput } from '../components/ui';
import { AFFILIATE_STATUS_TONE, filterAndSort, type Aff, type AffSortKey } from '../components/AffiliateShared';
import { money, date } from '../lib/format';

export default function Affiliates() {
  const { store } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const cur = store?.currency ?? 'USD';
  const [form, setForm] = useState<{ email: string; code: string; discountPct: string } | null>(null);
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [sort, setSort] = useState<{ key: AffSortKey; dir: 'asc' | 'desc' }>({ key: 'unsettled', dir: 'desc' });

  const key = ['affiliates', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Aff[]; commissionPct: number }>('/affiliates') });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/affiliates', { email: form!.email, code: form!.code || undefined, discountPct: Number(form!.discountPct || '10') }),
    onSuccess: (r) => { setForm(null); qc.invalidateQueries({ queryKey: key }); nav(`/affiliates/${r.id}`); },
  });

  const rows = useMemo(() => filterAndSort(data?.items ?? [], { search, activeOnly, ...sort }), [data, search, activeOnly, sort]);
  const totalOwed = useMemo(() => rows.reduce((sum, r) => sum + r.unsettled, 0), [rows]);

  const sortBy = (k: AffSortKey) => setSort((s) => s.key === k
    ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key: k, dir: k === 'email' || k === 'code' || k === 'status' ? 'asc' : 'desc' });
  const th = (k: AffSortKey, label: string, align?: 'right' | 'center') => (
    <th key={k} className={`th ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : ''}`} aria-sort={sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="hover:text-ink" onClick={() => sortBy(k)}>{label}{sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button>
    </th>
  );

  return (
    <>
      <PageHeader title="Affiliates" subtitle={data ? `${data.commissionPct}% commission on order subtotals` : undefined} actions={
        <button className="btn-primary" onClick={() => setForm(form ? null : { email: '', code: '', discountPct: '10' })}><Plus size={16} /> Onboard affiliate</button>
      } />

      {form && (
        <form className="card p-4 mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="flex-1 min-w-[14rem]"><label className="label">Affiliate email</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
          <div><label className="label">Coupon code</label><input className="input w-36" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="auto" /></div>
          <div><label className="label">Customer discount %</label><input className="input w-24" type="number" value={form.discountPct} onChange={(e) => setForm({ ...form, discountPct: e.target.value })} /></div>
          <button className="btn-primary" disabled={create.isPending || !form.email.trim()}>{create.isPending ? <Spinner className="text-white" /> : 'Create'}</button>
        </form>
      )}
      {create.error && <div className="mb-4"><ErrorNote message={(create.error as Error).message} /></div>}

      {data && data.items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search email or code…" />
          <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm" role="group" aria-label="Status filter">
            <button type="button" className={`px-3 py-1.5 ${activeOnly ? 'bg-gray-100 font-medium' : ''}`} aria-pressed={activeOnly} onClick={() => setActiveOnly(true)}>Active</button>
            <button type="button" className={`px-3 py-1.5 border-l border-gray-200 ${!activeOnly ? 'bg-gray-100 font-medium' : ''}`} aria-pressed={!activeOnly} onClick={() => setActiveOnly(false)}>All</button>
          </div>
          <span className="text-sm text-gray-500" data-testid="affiliate-count">{rows.length} {rows.length === 1 ? 'affiliate' : 'affiliates'} · {money(totalOwed, cur)} owed</span>
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? <EmptyState title="No affiliates yet" hint="Onboard one — it creates their coupon code automatically." /> : (
          <table className="w-full">
            <thead><tr>
              {th('email', 'Affiliate')}{th('code', 'Code')}{th('status', 'Status')}
              {th('orders', 'Orders', 'center')}{th('earned', 'Earned', 'right')}{th('settled', 'Paid', 'right')}
              {th('unsettled', 'Owed', 'right')}{th('lastSettledAt', 'Last settled')}
            </tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="row-link" onClick={() => nav(`/affiliates/${a.id}`)}>
                  <td className="td font-medium">{a.email}</td>
                  <td className="td font-mono text-xs">{a.code}</td>
                  <td className="td"><Badge value={a.status} tone={AFFILIATE_STATUS_TONE[a.status] ?? 'neutral'} /></td>
                  <td className="td text-center text-gray-500">{a.orders}</td>
                  <td className="td text-right">{money(a.earned, cur)}</td>
                  <td className="td text-right">{money(a.settled, cur)}</td>
                  <td className="td text-right font-medium">{a.unsettled > 0 ? <span className="text-warning">{money(a.unsettled, cur)}</span> : money(0, cur)}</td>
                  <td className="td text-gray-500">{date(a.lastSettledAt)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td className="td text-gray-500" colSpan={8}>No matches for the current filter.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
