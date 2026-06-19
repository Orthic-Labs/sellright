import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner } from '../components/ui';
import { money } from '../lib/format';

interface Promo { id: string; code: string | null; type: string; value: number; enabled: boolean; usedCount: number; usageLimit: number | null; perCustomerUsageLimit: number | null; }

export default function Discounts() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const cur = store?.currency ?? 'USD';
  const [form, setForm] = useState<{ code: string; type: string; value: string; usageLimit: string; perCustomerUsageLimit: string } | null>(null);

  const key = ['promotions', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Promo[] }>('/promotions') });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () => {
      const f = form!; const isPct = f.type === 'percentage';
      // percentage value = the percent integer (10 = 10%); fixed value = cents.
      return api.post('/promotions', { code: f.code, type: f.type, value: f.type === 'free_shipping' ? 0 : isPct ? Math.round(parseFloat(f.value || '0')) : Math.round(parseFloat(f.value || '0') * 100), usageLimit: f.usageLimit ? Number(f.usageLimit) : null, perCustomerUsageLimit: f.perCustomerUsageLimit ? Number(f.perCustomerUsageLimit) : null });
    },
    onSuccess: () => { setForm(null); invalidate(); },
  });
  const toggle = useMutation({ mutationFn: (p: Promo) => api.patch(`/promotions/${p.id}`, { enabled: !p.enabled }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/promotions/${id}`), onSuccess: invalidate });

  const fmtValue = (p: Promo) => p.type === 'percentage' ? `${p.value}%` : p.type === 'free_shipping' ? 'Free shipping' : money(p.value, cur);

  return (
    <>
      <PageHeader title="Discounts" subtitle="Coupon codes — usage is tracked and limits enforced at checkout." actions={
        <button className="btn-primary" onClick={() => setForm(form ? null : { code: '', type: 'percentage', value: '', usageLimit: '', perCustomerUsageLimit: '' })}><Plus size={16} /> New discount</button>
      } />

      {form && (
        <form className="card p-4 mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div><label className="label">Code</label><input className="input w-36" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="SAVE10" /></div>
          <div><label className="label">Type</label><select className="input w-40" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="percentage">Percentage</option><option value="fixed">Fixed amount</option><option value="free_shipping">Free shipping</option></select></div>
          {form.type !== 'free_shipping' && <div><label className="label">{form.type === 'percentage' ? 'Percent' : 'Amount'}</label><input className="input w-24" inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={form.type === 'percentage' ? '10' : '5.00'} /></div>}
          <div><label className="label">Total limit</label><input className="input w-24" type="number" value={form.usageLimit} onChange={(e) => setForm({ ...form, usageLimit: e.target.value })} placeholder="∞" /></div>
          <div><label className="label">Per customer</label><input className="input w-24" type="number" value={form.perCustomerUsageLimit} onChange={(e) => setForm({ ...form, perCustomerUsageLimit: e.target.value })} placeholder="∞" /></div>
          <button className="btn-primary" disabled={!form.code.trim() || create.isPending}>{create.isPending ? <Spinner className="text-white" /> : 'Create'}</button>
        </form>
      )}
      {create.error && <div className="mb-4"><ErrorNote message={(create.error as Error).message} /></div>}

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? <EmptyState title="No discounts yet" /> : (
          <table className="w-full">
            <thead><tr><th className="th">Code</th><th className="th">Value</th><th className="th">Used</th><th className="th">Status</th><th className="th"></th></tr></thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="border-t border-gray-100">
                  <td className="td font-mono font-medium">{p.code}</td>
                  <td className="td">{fmtValue(p)}</td>
                  <td className="td text-gray-500">{p.usedCount}{p.usageLimit ? ` / ${p.usageLimit}` : ''}{p.perCustomerUsageLimit ? ` · ${p.perCustomerUsageLimit}/cust` : ''}</td>
                  <td className="td"><button onClick={() => toggle.mutate(p)}><Badge value={p.enabled ? 'active' : 'draft'} /></button></td>
                  <td className="td text-right">{p.usedCount === 0 && <button className="text-gray-300 hover:text-danger" onClick={() => del.mutate(p.id)} title="Delete"><Trash2 size={15} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
