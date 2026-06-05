import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Spinner } from '../components/ui';
import { money } from '../lib/format';

interface Aff { id: string; email: string; code: string | null; earned: number; settled: number; unsettled: number; orders: number; }

export default function Affiliates() {
  const { store } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const cur = store?.currency ?? 'USD';
  const [form, setForm] = useState<{ email: string; code: string; discountPct: string } | null>(null);

  const key = ['affiliates', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Aff[]; commissionPct: number }>('/affiliates') });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/affiliates', { email: form!.email, code: form!.code || undefined, discountPct: Number(form!.discountPct || '10') }),
    onSuccess: (r) => { setForm(null); qc.invalidateQueries({ queryKey: key }); nav(`/affiliates/${r.id}`); },
  });

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

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? <EmptyState title="No affiliates yet" hint="Onboard one — it creates their coupon code automatically." /> : (
          <table className="w-full">
            <thead><tr><th className="th">Affiliate</th><th className="th">Code</th><th className="th text-center">Orders</th><th className="th text-right">Earned</th><th className="th text-right">Owed</th></tr></thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id} className="row-link" onClick={() => nav(`/affiliates/${a.id}`)}>
                  <td className="td font-medium">{a.email}</td>
                  <td className="td font-mono text-xs">{a.code}</td>
                  <td className="td text-center text-gray-500">{a.orders}</td>
                  <td className="td text-right">{money(a.earned, cur)}</td>
                  <td className="td text-right font-medium">{a.unsettled > 0 ? <span className="text-amber-600">{money(a.unsettled, cur)}</span> : money(0, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
