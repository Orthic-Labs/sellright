import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Package, CreditCard, Mail, ArrowRight, Truck, AlertTriangle, Users, CheckCircle2 } from 'lucide-react';
import { api, type Dashboard } from '../api';
import { useAuth } from '../auth';
import { money, dateTime } from '../lib/format';
import { Badge, Loading, ErrorState, PageHeader, KpiCard, EmptyStateActionPanel } from '../components/ui';

// An operational signal: a count that wants action when it's non-zero.
function OpCard({ label, count, hint, to, icon, danger }: {
  label: string; count: number; hint: string; to: string; icon: React.ReactNode; danger?: boolean;
}) {
  const attention = count > 0;
  const tone = attention ? (danger ? 'border-rose-200 bg-rose-50/60' : 'border-amber-200 bg-amber-50/60') : 'border-gray-200/80';
  const iconTone = !attention ? 'text-gray-300' : danger ? 'text-rose-500' : 'text-amber-500';
  return (
    <Link to={to} className={`panel border ${tone} p-4 flex items-start justify-between gap-3 hover:border-gray-300 transition-colors`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs font-medium text-gray-600"><span className={iconTone}>{icon}</span> {label}</div>
        <div className="mt-1 text-2xl font-semibold tnum">{count}</div>
        <div className="mt-0.5 text-xs text-gray-500">{attention ? hint : 'All clear'}</div>
      </div>
      <ArrowRight size={16} className="text-gray-300 mt-1 shrink-0" />
    </Link>
  );
}

export default function Dashboard() {
  const { store } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', store?.slug],
    queryFn: () => api.get<Dashboard>('/dashboard'),
  });

  if (isLoading) return <Loading />;
  if (error) return <div className="card overflow-hidden"><ErrorState message={(error as Error).message} onRetry={() => refetch()} /></div>;
  if (!data) return null;
  const cur = data.store.currency;
  const fresh = data.orders === 0;

  return (
    <>
      <PageHeader title="Welcome back" subtitle={data.store.name} />

      {fresh ? (
        <div className="panel p-6 mb-6">
          <h2 className="text-sm font-semibold">Get your store ready</h2>
          <p className="mt-0.5 text-sm text-gray-500">A few steps to start taking orders.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {[
              { icon: <Package size={16} />, title: 'Add a product', desc: 'Build your catalog', to: '/products/new' },
              { icon: <CreditCard size={16} />, title: 'Set up payments', desc: 'Connect a provider', to: '/settings' },
              { icon: <Mail size={16} />, title: 'Connect marketing', desc: 'Sync your audience', to: '/marketing' },
            ].map((s) => (
              <Link key={s.title} to={s.to} className="panel border p-4 hover:border-gray-300 transition-colors">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand-light text-brand">{s.icon}</div>
                <div className="mt-3 text-sm font-medium">{s.title}</div>
                <div className="text-xs text-gray-500">{s.desc}</div>
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Needs-action operational signals first — answer "what needs me?" in one scan. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <OpCard label="To fulfill" count={data.pendingFulfillment} hint="paid, awaiting shipment" to="/orders?state=Paid" icon={<Truck size={14} />} />
            <OpCard label="Low stock" count={data.lowStock} hint="≤ 3 available" to="/inventory" icon={<AlertTriangle size={14} />} danger />
            <KpiCard label="Customers" value={<span>{data.customers}</span>} hint="total" icon={<Users size={16} />} to="/customers" />
            <KpiCard label="Avg order value" value={money(data.aov, cur)} hint="paid orders" icon={<CheckCircle2 size={16} />} />
          </div>
          <div className="grid grid-cols-2 gap-3 mb-6">
            <KpiCard label="Revenue" value={money(data.revenue, cur)} hint={`${data.orders} paid orders · all-time`} />
            <KpiCard label="Paid orders" value={<span className="tnum">{data.orders}</span>} hint="all-time" to="/orders?state=Paid" />
          </div>
        </>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold">Recent orders</h2>
          <Link to="/orders" className="text-sm text-brand hover:underline">View all</Link>
        </div>
        {data.recentOrders.length === 0 ? (
          <EmptyStateActionPanel title="No orders yet" description="When customers check out, their orders show up here." actions={[{ label: 'Create an order', to: '/orders/new', variant: 'ghost' }]} />
        ) : (
          <table className="w-full table-fixed">
            <thead><tr>
              <th className="th" style={{ width: '20%' }}>Order</th><th className="th" style={{ width: '24%' }}>Date</th><th className="th">Customer</th><th className="th" style={{ width: '16%' }}>Status</th><th className="th text-right" style={{ width: '15%' }}>Total</th>
            </tr></thead>
            <tbody>
              {data.recentOrders.map((o) => (
                <tr key={o.code} className="row-link" onClick={() => location.assign(`/orders/${o.code}`)}>
                  <td className="td font-medium">{o.code}</td>
                  <td className="td text-gray-500">{dateTime(o.placedAt ?? o.createdAt)}</td>
                  <td className="td text-gray-600 truncate">{o.email ?? '—'}</td>
                  <td className="td"><Badge value={o.state} /></td>
                  <td className="td text-right font-medium tnum">{money(o.grandTotal, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
