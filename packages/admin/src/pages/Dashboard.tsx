import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Dashboard } from '../api';
import { useAuth } from '../auth';
import { money, dateTime } from '../lib/format';
import { Badge, Loading, ErrorNote, PageHeader, EmptyState } from '../components/ui';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1">{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
    </div>
  );
}

export default function Dashboard() {
  const { store } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', store?.slug],
    queryFn: () => api.get<Dashboard>('/dashboard'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote message={(error as Error).message} />;
  if (!data) return null;
  const cur = data.store.currency;

  return (
    <>
      <PageHeader title={`Welcome back`} subtitle={data.store.name} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Stat label="Revenue" value={money(data.revenue, cur)} hint={`${data.orders} paid orders`} />
        <Stat label="Avg order value" value={money(data.aov, cur)} />
        <Stat label="To fulfill" value={String(data.pendingFulfillment)} hint="paid, not shipped" />
        <Stat label="Low stock" value={String(data.lowStock)} hint="≤ 3 available" />
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold">Recent orders</h2>
          <Link to="/orders" className="text-sm text-brand hover:underline">View all</Link>
        </div>
        {data.recentOrders.length === 0 ? (
          <EmptyState title="No orders yet" />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Order</th><th className="th">Date</th><th className="th">Customer</th><th className="th">Status</th><th className="th text-right">Total</th>
            </tr></thead>
            <tbody>
              {data.recentOrders.map((o) => (
                <tr key={o.code} className="row-link" onClick={() => location.assign(`/orders/${o.code}`)}>
                  <td className="td font-medium">{o.code}</td>
                  <td className="td text-gray-500">{dateTime(o.placedAt ?? o.createdAt)}</td>
                  <td className="td text-gray-600">{o.email ?? '—'}</td>
                  <td className="td"><Badge value={o.state} /></td>
                  <td className="td text-right font-medium">{money(o.grandTotal, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
