import { useQuery } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, BadgeCheck } from 'lucide-react';
import { api, type CustomerDetail } from '../api';
import { useAuth } from '../auth';
import { money, date, dateTime, initials } from '../lib/format';
import { Badge, Loading, ErrorNote, EmptyState } from '../components/ui';

export default function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { store } = useAuth();
  const nav = useNavigate();
  const cur = store?.currency ?? 'USD';

  const { data: c, isLoading, error } = useQuery({
    queryKey: ['customer', store?.slug, id],
    queryFn: () => api.get<CustomerDetail>(`/customers/${id}`),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote message={(error as Error).message} />;
  if (!c) return null;

  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email;
  const spent = c.orders.filter((o) => ['Paid', 'PartiallyRefunded', 'Refunded'].includes(o.state)).reduce((s, o) => s + o.grandTotal, 0);

  return (
    <>
      <Link to="/customers" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Customers</Link>
      <div className="flex items-center gap-3 mb-5">
        <div className="h-11 w-11 rounded-full bg-brand-light text-brand grid place-items-center text-sm font-semibold">{initials(c.email, c.firstName, c.lastName)}</div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">{name} {c.emailVerified && <BadgeCheck size={16} className="text-brand" />}</h1>
          <div className="text-sm text-gray-500">{c.email} · joined {date(c.createdAt)}</div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Orders</div>
          {c.orders.length === 0 ? <EmptyState title="No orders yet" /> : (
            <table className="w-full">
              <thead><tr><th className="th">Order</th><th className="th">Date</th><th className="th">Status</th><th className="th text-right">Total</th></tr></thead>
              <tbody>
                {c.orders.map((o) => (
                  <tr key={o.code} className="row-link" onClick={() => nav(`/orders/${o.code}`)}>
                    <td className="td font-medium">{o.code}</td>
                    <td className="td text-gray-500">{dateTime(o.placedAt ?? o.createdAt)}</td>
                    <td className="td"><Badge value={o.state} /></td>
                    <td className="td text-right font-medium">{money(o.grandTotal, o.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="space-y-5">
          <div className="card p-4 grid grid-cols-2 gap-3">
            <div><div className="text-xs text-gray-500">Total spent</div><div className="text-lg font-semibold">{money(spent, cur)}</div></div>
            <div><div className="text-xs text-gray-500">Orders</div><div className="text-lg font-semibold">{c.orders.length}</div></div>
          </div>
          {c.phone && <div className="card p-4"><div className="text-sm font-semibold mb-1">Contact</div><div className="text-sm text-gray-600">{c.phone}</div></div>}
          <div className="card p-4">
            <div className="text-sm font-semibold mb-2">Addresses</div>
            {c.addresses.length === 0 ? <span className="text-sm text-gray-400">None on file</span> : c.addresses.map((a, i) => (
              <div key={i} className="text-sm text-gray-600 mb-2 last:mb-0">
                {a.fullName && <div className="font-medium text-ink">{a.fullName}</div>}
                <div>{[a.line1, a.line2].filter(Boolean).join(', ')}</div>
                <div>{[a.city, a.province, a.postalCode].filter(Boolean).join(' ')}</div>
                <div>{a.country}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
