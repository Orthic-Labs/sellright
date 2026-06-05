import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Truck, CheckCircle2, XCircle } from 'lucide-react';
import { api, type OrderDetail } from '../api';
import { useAuth } from '../auth';
import { money, dateTime } from '../lib/format';
import { Badge, Loading, ErrorNote, Spinner } from '../components/ui';

function addr(a: Record<string, unknown> | null): string[] {
  if (!a) return [];
  const g = (k: string) => (a[k] != null ? String(a[k]) : '');
  return [
    g('fullName'),
    [g('streetLine1') || g('line1'), g('streetLine2') || g('line2')].filter(Boolean).join(', '),
    [g('city'), g('province'), g('postalCode')].filter(Boolean).join(' '),
    g('countryCode') || g('country'),
    g('phone'),
  ].filter(Boolean);
}

export default function OrderDetailPage() {
  const { code = '' } = useParams();
  const { store } = useAuth();
  const qc = useQueryClient();
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState('');

  const { data: o, isLoading, error } = useQuery({
    queryKey: ['order', store?.slug, code],
    queryFn: () => api.get<OrderDetail>(`/orders/${encodeURIComponent(code)}`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['order', store?.slug, code] });
  const fulfill = useMutation({
    mutationFn: (body: { state: 'Shipped' | 'Delivered'; trackingCode?: string; carrier?: string }) =>
      api.post(`/orders/${encodeURIComponent(code)}/fulfill`, body),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/orders/${encodeURIComponent(code)}/cancel`, {}),
    onSuccess: invalidate,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote message={(error as Error).message} />;
  if (!o) return null;

  const cur = o.currency;
  const latestFul = o.fulfillments[0];
  const canFulfill = o.state === 'Paid' || o.state === 'PartiallyRefunded';
  const canCancel = o.state === 'PendingPayment' || o.state === 'Paid';
  const actionErr = (fulfill.error || cancel.error) as Error | null;

  return (
    <>
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Orders</Link>
      <div className="flex items-center gap-3 mb-5">
        <h1 className="text-xl font-semibold tracking-tight">{o.code}</h1>
        <Badge value={o.state} />
        {latestFul && <Badge value={latestFul.state} />}
        <span className="text-sm text-gray-400 ml-auto">{dateTime(o.placedAt ?? o.createdAt)}</span>
      </div>

      {actionErr && <div className="mb-4"><ErrorNote message={actionErr.message} /></div>}

      <div className="grid lg:grid-cols-3 gap-5">
        {/* Left: items + actions + timeline */}
        <div className="lg:col-span-2 space-y-5">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Items</div>
            <table className="w-full">
              <tbody>
                {o.lines.map((l, i) => (
                  <tr key={i} className="border-t border-gray-100 first:border-0">
                    <td className="td">
                      <div className="font-medium">{l.name}</div>
                      <div className="text-xs text-gray-400">{l.sku} · {money(l.unitPrice, cur)} × {l.quantity}
                        {l.fulfilledQty > 0 && <span className="text-emerald-600"> · {l.fulfilledQty} shipped</span>}</div>
                    </td>
                    <td className="td text-right font-medium whitespace-nowrap">{money(l.lineTotal, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-gray-100 px-4 py-3 space-y-1 text-sm">
              <Row label="Subtotal" value={money(o.subtotal, cur)} />
              {o.discountTotal > 0 && <Row label="Discount" value={`− ${money(o.discountTotal, cur)}`} />}
              <Row label="Shipping" value={money(o.shippingTotal, cur)} />
              {o.taxTotal > 0 && <Row label="Tax" value={money(o.taxTotal, cur)} />}
              <div className="flex justify-between pt-1 border-t border-gray-100 mt-1 font-semibold">
                <span>Total</span><span>{money(o.grandTotal, cur)}</span>
              </div>
            </div>
          </div>

          {/* Fulfillment actions */}
          <div className="card p-4">
            <div className="text-sm font-semibold mb-3">Fulfillment</div>
            {!canFulfill && o.state !== 'PendingPayment' && <p className="text-sm text-gray-500">Order is {o.state.toLowerCase()}; no fulfillment actions.</p>}
            {o.state === 'PendingPayment' && <p className="text-sm text-amber-600">Awaiting payment before fulfillment.</p>}
            {canFulfill && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="label">Tracking #</label><input className="input" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="optional" /></div>
                  <div><label className="label">Carrier</label><input className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="optional" /></div>
                </div>
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={fulfill.isPending}
                    onClick={() => fulfill.mutate({ state: 'Shipped', trackingCode: tracking || undefined, carrier: carrier || undefined })}>
                    {fulfill.isPending ? <Spinner className="text-white" /> : <><Truck size={16} /> Mark as shipped</>}
                  </button>
                  {latestFul?.state === 'Shipped' && (
                    <button className="btn-ghost" disabled={fulfill.isPending} onClick={() => fulfill.mutate({ state: 'Delivered' })}>
                      <CheckCircle2 size={16} /> Mark delivered
                    </button>
                  )}
                </div>
              </div>
            )}
            {latestFul && (
              <div className="mt-3 text-xs text-gray-500">
                {latestFul.state}{latestFul.trackingCode ? ` · ${latestFul.carrier ?? ''} ${latestFul.trackingCode}` : ''} · {dateTime(latestFul.createdAt)}
              </div>
            )}
          </div>

          {/* Timeline */}
          {o.events.length > 0 && (
            <div className="card p-4">
              <div className="text-sm font-semibold mb-3">Timeline</div>
              <ul className="space-y-2">
                {o.events.map((e, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-gray-300 shrink-0" />
                    <span className="text-gray-600">
                      <span className="font-medium capitalize">{e.action}</span>
                      {e.toState && ` → ${e.toState}`}
                      <span className="text-gray-400"> · {dateTime(e.at)}{e.actor ? ` · ${e.actor}` : ''}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Right: customer + payment + danger */}
        <div className="space-y-5">
          <div className="card p-4">
            <div className="text-sm font-semibold mb-2">Customer</div>
            {o.customer ? (
              <Link to={`/customers/${o.customer.id}`} className="text-sm text-brand hover:underline">
                {[o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ') || o.customer.email}
              </Link>
            ) : <span className="text-sm text-gray-400">Guest</span>}
            {o.customer?.email && <div className="text-sm text-gray-500 mt-0.5">{o.customer.email}</div>}
            {o.customer?.phone && <div className="text-sm text-gray-500">{o.customer.phone}</div>}
          </div>

          <div className="card p-4">
            <div className="text-sm font-semibold mb-2">Shipping address</div>
            {addr(o.shippingAddress).length ? addr(o.shippingAddress).map((l, i) => <div key={i} className="text-sm text-gray-600">{l}</div>) : <span className="text-sm text-gray-400">None</span>}
          </div>

          <div className="card p-4">
            <div className="text-sm font-semibold mb-2">Payment</div>
            {o.payments.length === 0 ? <span className="text-sm text-gray-400">No payments</span> : o.payments.map((p, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="capitalize text-gray-600">{p.method}</span>
                <span className="flex items-center gap-2"><Badge value={p.state === 'Settled' ? 'Paid' : p.state} /> {money(p.amount, cur)}</span>
              </div>
            ))}
          </div>

          {canCancel && (
            <div className="card p-4 border-red-200">
              <div className="text-sm font-semibold mb-2 text-red-700">Danger zone</div>
              <button className="btn-danger w-full" disabled={cancel.isPending}
                onClick={() => { if (confirm(`Cancel order ${o.code}? Stock will be released.`)) cancel.mutate(); }}>
                {cancel.isPending ? <Spinner /> : <><XCircle size={16} /> Cancel order</>}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-gray-600"><span>{label}</span><span>{value}</span></div>;
}
