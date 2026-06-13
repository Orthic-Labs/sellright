import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, Package, Users } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorState, PageHeader, KpiCard, EmptyState } from '../components/ui';
import { money } from '../lib/format';

type Series = { day: string; orders: number; revenue: number }[];

// Period-over-period from the real series: compare the recent half against the
// prior half (each an equal-length window). Honest — derived, not invented.
function halfDelta(series: Series, pick: (s: Series[number]) => number): number | null {
  if (!series || series.length < 4) return null;
  const mid = Math.floor(series.length / 2);
  const prev = series.slice(0, mid).reduce((a, s) => a + Number(pick(s)), 0);
  const cur = series.slice(mid).reduce((a, s) => a + Number(pick(s)), 0);
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 100);
}

export default function Reports() {
  const { store } = useAuth();
  const nav = useNavigate();
  const cur = store?.currency ?? 'USD';
  const [days, setDays] = useState(30);

  const sales = useQuery({ queryKey: ['rep-sales', store?.slug, days], queryFn: () => api.get<{ totalRevenue: number; totalOrders: number; series: Series }>(`/reports/sales?days=${days}`) });
  const products = useQuery({ queryKey: ['rep-products', store?.slug, days], queryFn: () => api.get<{ items: { name: string; sku: string; qty: number; revenue: number }[] }>(`/reports/top-products?days=${days}`) });
  const customers = useQuery({ queryKey: ['rep-customers', store?.slug, days], queryFn: () => api.get<{ items: { id: string; email: string; spent: number; orders: number }[] }>(`/reports/top-customers?days=${days}`) });

  const series = sales.data?.series ?? [];
  const maxRev = Math.max(1, ...series.map((s) => Number(s.revenue)));
  const revDelta = halfDelta(series, (s) => s.revenue);
  const ordDelta = halfDelta(series, (s) => s.orders);
  const noData = sales.data && sales.data.totalOrders === 0;

  return (
    <>
      <PageHeader title="Reports" subtitle={`Last ${days} days`} actions={
        <select className="input w-32" aria-label="Reporting period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option>
        </select>
      } />

      {sales.isLoading ? <Loading /> : sales.error ? <div className="card overflow-hidden"><ErrorState message={(sales.error as Error).message} onRetry={() => sales.refetch()} /></div> : sales.data && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700"><TrendingUp size={15} className="text-gray-400" /> Sales</h2>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <KpiCard label="Revenue" value={money(sales.data.totalRevenue, cur)} delta={revDelta} hint="vs previous period" />
            <KpiCard label="Orders" value={<span className="tnum">{sales.data.totalOrders}</span>} delta={ordDelta} hint="vs previous period" />
            <KpiCard label="Avg order" value={money(sales.data.totalOrders ? Math.round(sales.data.totalRevenue / sales.data.totalOrders) : 0, cur)} />
          </div>
          <div className="card p-4">
            {noData ? (
              <EmptyState title="No orders in this period" hint="Try a longer date range — this store may have orders outside the selected window." />
            ) : (
              <div className="flex items-end gap-0.5 h-28">
                {series.map((s) => (
                  <div key={s.day} className="flex-1 bg-brand/80 rounded-t hover:bg-brand transition-colors" style={{ height: `${Math.max(2, (Number(s.revenue) / maxRev) * 100)}%` }} title={`${s.day}: ${money(Number(s.revenue), cur)} (${s.orders})`} />
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700"><Package size={15} className="text-gray-400" /> Top products</h2>
          <div className="panel overflow-hidden">
            {products.isLoading ? <Loading /> : !products.data || products.data.items.length === 0 ? <EmptyState title="No product sales yet" /> : (
              <table className="w-full table-fixed"><tbody>
                {products.data.items.map((p, i) => (
                  <tr key={i} className="border-t border-gray-100 first:border-0"><td className="td"><div className="font-medium truncate">{p.name}</div><div className="text-xs text-gray-400">{p.sku} · {p.qty} sold</div></td><td className="td text-right font-medium tnum" style={{ width: '30%' }}>{money(Number(p.revenue), cur)}</td></tr>
                ))}
              </tbody></table>
            )}
          </div>
        </section>
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700"><Users size={15} className="text-gray-400" /> Top customers</h2>
          <div className="panel overflow-hidden">
            {customers.isLoading ? <Loading /> : !customers.data || customers.data.items.length === 0 ? <EmptyState title="No customer activity yet" /> : (
              <table className="w-full table-fixed"><tbody>
                {customers.data.items.map((c, i) => (
                  <tr key={i} className="row-link border-t border-gray-100 first:border-0" onClick={() => nav(`/customers/${c.id}`)}><td className="td"><div className="font-medium truncate">{c.email}</div><div className="text-xs text-gray-400">{c.orders} orders</div></td><td className="td text-right font-medium tnum" style={{ width: '30%' }}>{money(Number(c.spent), cur)}</td></tr>
                ))}
              </tbody></table>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
