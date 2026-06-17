import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Truck, CheckCircle2, XCircle } from 'lucide-react';
import { api, type OrderDetail } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { money, dateTime } from '../lib/format';
import { PageHeader, StatusBadge, FormSection, InlineAlert, ErrorState, Loading, Field, Spinner } from '../components/ui';

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

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'An unexpected error occurred';
}

export default function OrderDetailPage() {
  const { code = '' } = useParams();
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
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
    onSuccess: (_d, body) => { invalidate(); toast.success(body.state === 'Delivered' ? 'Order marked delivered' : 'Order marked shipped'); },
    onError: (e) => toast.error('Fulfillment failed', getErrorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/orders/${encodeURIComponent(code)}/cancel`, {}),
    onSuccess: () => { invalidate(); toast.success('Order cancelled'); },
    onError: (e) => toast.error('Cancel failed', getErrorMessage(e)),
  });
  const [refundAmt, setRefundAmt] = useState('');
  const [restock, setRestock] = useState(true);
  const refund = useMutation({
    mutationFn: () => {
      let amount: number | undefined;
      if (refundAmt.trim()) {
        const parsed = Number(refundAmt);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid refund amount');
        amount = Math.round(parsed * 100);
      }
      return api.post(`/orders/${encodeURIComponent(code)}/refund`, { amount, restock });
    },
    onSuccess: () => { setRefundAmt(''); invalidate(); toast.success('Refund issued'); },
    onError: (e) => toast.error('Refund failed', getErrorMessage(e)),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState title="Couldn't load this order" message={(error as Error).message} onRetry={invalidate} />;
  if (!o) return null;

  const cur = o.currency;
  const latestFul = o.fulfillments[0];
  const canFulfill = o.state === 'Paid' || o.state === 'PartiallyRefunded';
  const canCancel = o.state === 'PendingPayment' || o.state === 'Paid';
  const canRefund = o.state === 'Paid' || o.state === 'PartiallyRefunded';

  return (
    <>
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Orders</Link>
      <PageHeader
        title={o.code}
        subtitle={dateTime(o.placedAt ?? o.createdAt)}
        actions={<div className="flex items-center gap-2"><StatusBadge value={o.state} />{latestFul && <StatusBadge value={latestFul.state} />}</div>}
      />

      {(fulfill.error || cancel.error || refund.error) && <div className="mb-4"><InlineAlert tone="critical">{getErrorMessage(fulfill.error || cancel.error || refund.error)}</InlineAlert></div>}

      <div className="grid lg:grid-cols-3 gap-5">
        {/* Left: items + actions + timeline */}
        <div className="lg:col-span-2 space-y-5">
          <FormSection title="Items" description={`${o.lines.length} line${o.lines.length === 1 ? '' : 's'} on this order`}>
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
            <div className="space-y-1 text-sm pt-2">
              <Row label="Subtotal" value={money(o.subtotal, cur)} />
              {o.discountTotal > 0 && <Row label="Discount" value={`− ${money(o.discountTotal, cur)}`} />}
              <Row label="Shipping" value={money(o.shippingTotal, cur)} />
              {o.taxTotal > 0 && <Row label="Tax" value={money(o.taxTotal, cur)} />}
              <div className="flex justify-between pt-1 border-t border-gray-100 mt-1 font-semibold">
                <span>Total</span><span>{money(o.grandTotal, cur)}</span>
              </div>
            </div>
          </FormSection>

          {/* Fulfillment actions */}
          <FormSection
            title="Fulfillment"
            description={canFulfill
              ? 'Mark as shipped when the carrier picks up. Mark as delivered after the package is received.'
              : o.state === 'PendingPayment' ? 'Order is awaiting payment.' : `Order is ${o.state.toLowerCase()}; no fulfillment actions.`}
          >
            {canFulfill ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Tracking #"><input className="input" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="optional" /></Field>
                  <Field label="Carrier"><input className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="optional" /></Field>
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
            ) : null}
            {latestFul && (
              <div className="text-xs text-gray-500 pt-2 border-t border-gray-100">
                {latestFul.state}{latestFul.trackingCode ? ` · ${latestFul.carrier ?? ''} ${latestFul.trackingCode}` : ''} · {dateTime(latestFul.createdAt)}
              </div>
            )}
          </FormSection>

          {/* Timeline */}
          {o.events.length > 0 && (
            <FormSection title="Timeline" description="Recent activity for this order">
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
            </FormSection>
          )}
        </div>

        {/* Right: customer + payment + danger */}
        <div className="space-y-5">
          <FormSection title="Customer" description={o.customer ? 'Linked to this store' : 'Guest checkout'}>
            {o.customer ? (
              <Link to={`/customers/${o.customer.id}`} className="text-sm text-brand hover:underline">
                {[o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ') || o.customer.email}
              </Link>
            ) : <span className="text-sm text-gray-400">Guest</span>}
            {o.customer?.email && <div className="text-sm text-gray-500 mt-0.5">{o.customer.email}</div>}
            {o.customer?.phone && <div className="text-sm text-gray-500">{o.customer.phone}</div>}
          </FormSection>

          <FormSection title="Shipping address">
            {addr(o.shippingAddress).length ? addr(o.shippingAddress).map((l, i) => <div key={i} className="text-sm text-gray-600">{l}</div>) : <span className="text-sm text-gray-400">None</span>}
          </FormSection>

          <FormSection title="Payment">
            {o.payments.length === 0 ? <span className="text-sm text-gray-400">No payments</span> : o.payments.map((p, i) => (
              <div key={i} className="flex items-center justify-between text-sm py-1">
                <span className="capitalize text-gray-600">{p.method}</span>
                <span className="flex items-center gap-2"><StatusBadge value={p.state === 'Settled' ? 'Paid' : p.state} /> {money(p.amount, cur)}</span>
              </div>
            ))}
          </FormSection>

          {canRefund && (
            <FormSection title="Refund" description="Partial refunds are supported. Restock puts the items back into inventory.">
              <Field label={`Amount (${cur})`} hint="Blank = full remaining"><input className="input" inputMode="decimal" value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} placeholder={(o.grandTotal / 100).toFixed(2)} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Restock items</label>
              <div className="pt-2"><button className="btn-danger" disabled={refund.isPending} onClick={() => { if (confirm('Issue this refund?')) refund.mutate(); }}>
                {refund.isPending ? <Spinner /> : 'Issue refund'}
              </button></div>
            </FormSection>
          )}

          {canCancel && (
            <div className="border-red-200 [&>section]:border-red-200">
              <FormSection title="Danger zone" description="Cancelling releases reserved stock. Refund must be issued separately.">
                <button className="btn-danger" disabled={cancel.isPending}
                  onClick={() => { if (confirm(`Cancel order ${o.code}? Stock will be released.`)) cancel.mutate(); }}>
                  {cancel.isPending ? <Spinner /> : <><XCircle size={16} /> Cancel order</>}
                </button>
              </FormSection>
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
