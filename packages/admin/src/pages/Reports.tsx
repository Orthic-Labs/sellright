import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader } from '../components/ui';
import { money } from '../lib/format';

export default function Reports() {
  const { store } = useAuth();
  const nav = useNavigate();
  const cur = store?.currency ?? 'USD';
  const [days, setDays] = useState(30);

  const sales = useQuery({ queryKey: ['rep-sales', store?.slug, days], queryFn: () => api.get<{ totalRevenue: number; totalOrders: number; series: { day: string; orders: number; revenue: number }[] }>(`/reports/sales?days=${days}`) });
  const products = useQuery({ queryKey: ['rep-products', store?.slug, days], queryFn: () => api.get<{ items: { name: string; sku: string; qty: number; revenue: number }[] }>(`/reports/top-products?days=${days}`) });
  const customers = useQuery({ queryKey: ['rep-customers', store?.slug, days], queryFn: () => api.get<{ items: { id: string; email: string; spent: number; orders: number }[] }>(`/reports/top-customers?days=${days}`) });

  const maxRev = Math.max(1, ...(sales.data?.series.map((s) => Number(s.revenue)) ?? [1]));

  return (
    <>
      <PageHeader title="Reports" subtitle={`Last ${days} days`} actions={
        <select className="input w-32" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option>
        </select>
      } />

      {sales.isLoading ? <Loading /> : sales.error ? <ErrorNote message={(sales.error as Error).message} /> : sales.data && (
        <div className="card p-4 mb-5">
          <div className="flex gap-8 mb-4">
            <div><div className="text-xs text-gray-500">Revenue</div><div className="text-2xl font-semibold">{money(sales.data.totalRevenue, cur)}</div></div>
            <div><div className="text-xs text-gray-500">Orders</div><div className="text-2xl font-semibold">{sales.data.totalOrders}</div></div>
            <div><div className="text-xs text-gray-500">Avg order</div><div className="text-2xl font-semibold">{money(sales.data.totalOrders ? Math.round(sales.data.totalRevenue / sales.data.totalOrders) : 0, cur)}</div></div>
          </div>
          <div className="flex items-end gap-0.5 h-28">
            {sales.data.series.map((s) => (
              <div key={s.day} className="flex-1 bg-brand/80 rounded-t hover:bg-brand transition-colors" style={{ height: `${Math.max(2, (Number(s.revenue) / maxRev) * 100)}%` }} title={`${s.day}: ${money(Number(s.revenue), cur)} (${s.orders})`} />
            ))}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Top products</div>
          <table className="w-full"><tbody>
            {products.data?.items.map((p, i) => (
              <tr key={i} className="border-t border-gray-100 first:border-0"><td className="td"><div className="font-medium">{p.name}</div><div className="text-xs text-gray-400">{p.sku} · {p.qty} sold</div></td><td className="td text-right font-medium">{money(Number(p.revenue), cur)}</td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Top customers</div>
          <table className="w-full"><tbody>
            {customers.data?.items.map((c, i) => (
              <tr key={i} className="row-link border-t border-gray-100 first:border-0" onClick={() => nav(`/customers/${c.id}`)}><td className="td"><div className="font-medium">{c.email}</div><div className="text-xs text-gray-400">{c.orders} orders</div></td><td className="td text-right font-medium">{money(Number(c.spent), cur)}</td></tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </>
  );
}
