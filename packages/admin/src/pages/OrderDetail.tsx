import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Truck, CheckCircle2, XCircle, StickyNote, Pencil } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { money, dateTime } from '../lib/format';
import { PageHeader, StatusBadge, FormSection, InlineAlert, ErrorState, Loading, Field, Spinner } from '../components/ui';
import { OrderEditPanel } from '../components/order-edit/OrderEditPanel';
import { AddressCard } from '../components/order-edit/AddressCard';
import type { AddressForm, OrderDetailX } from '../components/order-edit/types';

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'An unexpected error occurred';
}

/** Remaining unfulfilled quantity on a line (never negative). */
function unfulfilled(l: { quantity: number; fulfilledQty: number; cancelledQty: number }): number {
  return Math.max(0, l.quantity - l.fulfilledQty - l.cancelledQty);
}
/** Remaining un-refunded quantity on a line (never negative). */
function unrefunded(l: { quantity: number; refundedQty: number }): number {
  return Math.max(0, l.quantity - l.refundedQty);
}

export default function OrderDetailPage() {
  const { code = '' } = useParams();
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const { data: o, isLoading, error } = useQuery({
    queryKey: ['order', store?.slug, code],
    queryFn: () => api.get<OrderDetailX>(`/orders/${encodeURIComponent(code)}`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['order', store?.slug, code] });

  // ── order editing (G13) + direct address edit (G5) ───────────────────────
  const [editing, setEditing] = useState(false);
  const [pendingAddress, setPendingAddress] = useState<{ form: AddressForm; saveToAddressBook: boolean } | null>(null);
  const afterEdit = () => {
    setEditing(false); setPendingAddress(null); invalidate();
    qc.invalidateQueries({ queryKey: ['order-edit-context', code] });
  };

  const cancel = useMutation({
    mutationFn: () => api.post(`/orders/${encodeURIComponent(code)}/cancel`, {}),
    onSuccess: () => { invalidate(); toast.success('Order cancelled'); },
    onError: (e) => toast.error('Cancel failed', getErrorMessage(e)),
  });

  // ── partial fulfillment ──────────────────────────────────────────────────
  const [fulfillQty, setFulfillQty] = useState<Record<string, string>>({});
  const [fulfillLocation, setFulfillLocation] = useState('');
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const fulfill = useMutation({
    mutationFn: () => {
      const lines = Object.entries(fulfillQty)
        .map(([orderLineId, v]) => ({ orderLineId, quantity: Number(v) }))
        .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
      if (!lines.length) throw new Error('Select at least one line to ship');
      return api.post(`/orders/${encodeURIComponent(code)}/fulfillments`, {
        lines, locationId: fulfillLocation || undefined,
        trackingCode: tracking || undefined, carrier: carrier || undefined, notifyCustomer,
      });
    },
    onSuccess: () => {
      invalidate();
      setFulfillQty({}); setTracking(''); setCarrier('');
      toast.success('Fulfillment created');
    },
    onError: (e) => toast.error('Fulfillment failed', getErrorMessage(e)),
  });

  const markDelivered = useMutation({
    mutationFn: () => api.post(`/orders/${encodeURIComponent(code)}/fulfill`, { state: 'Delivered' }),
    onSuccess: () => { invalidate(); toast.success('Order marked delivered'); },
    onError: (e) => toast.error('Failed', getErrorMessage(e)),
  });

  // ── per-line refund ──────────────────────────────────────────────────────
  const [refundQty, setRefundQty] = useState<Record<string, string>>({});
  const [refundRestock, setRefundRestock] = useState<Record<string, boolean>>({});
  const [shippingAmt, setShippingAmt] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundKey, setRefundKey] = useState(() => crypto.randomUUID());

  const refundLineSelection = useMemo(() => {
    if (!o) return [] as { orderLineId: string; quantity: number; restock: boolean }[];
    return o.lines
      .map((l) => ({ orderLineId: l.id, quantity: Number(refundQty[l.id] || 0), restock: !!refundRestock[l.id], unitPrice: l.unitPrice }))
      .filter((l) => l.quantity > 0);
  }, [o, refundQty, refundRestock]);

  const refundItemsTotal = useMemo(() => {
    if (!o) return 0;
    return refundLineSelection.reduce((sum, l) => {
      const line = o.lines.find((x) => x.id === l.orderLineId);
      return sum + (line ? Math.round((line.lineTotal / line.quantity) * l.quantity) : 0);
    }, 0);
  }, [o, refundLineSelection]);
  const refundShippingCents = Math.max(0, Math.round(Number(shippingAmt || 0) * 100)) || 0;
  const refundComputedTotal = refundItemsTotal + refundShippingCents;

  const refund = useMutation({
    mutationFn: () => {
      const lines = refundLineSelection.map(({ orderLineId, quantity, restock }) => ({ orderLineId, quantity, restock }));
      return api.post<{ refundState: string }>(`/orders/${encodeURIComponent(code)}/refund`, {
        idempotencyKey: refundKey,
        lines: lines.length ? lines : undefined,
        shippingAmount: lines.length && refundShippingCents > 0 ? refundShippingCents : undefined,
        reason: refundReason.trim() || undefined,
        // Full-remaining fallback when no lines were selected (blank = full
        // remaining, unchanged from the original single-field behavior).
        restock: lines.length ? undefined : false,
      });
    },
    onSuccess: (result) => {
      invalidate();
      if (result.refundState === 'Settled') {
        setRefundQty({}); setRefundRestock({}); setShippingAmt(''); setRefundReason(''); setRefundKey(crypto.randomUUID());
        toast.success('Refund issued');
      } else if (result.refundState === 'Pending') toast.success('Refund pending confirmation');
      else { setRefundKey(crypto.randomUUID()); toast.error('Refund declined'); }
    },
    onError: (e) => toast.error('Refund failed', getErrorMessage(e)),
  });

  // ── internal notes ───────────────────────────────────────────────────────
  const [noteText, setNoteText] = useState('');
  const addNote = useMutation({
    mutationFn: () => api.post(`/orders/${encodeURIComponent(code)}/notes`, { note: noteText.trim() }),
    onSuccess: () => { invalidate(); setNoteText(''); toast.success('Note added'); },
    onError: (e) => toast.error('Could not add note', getErrorMessage(e)),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState title="Couldn't load this order" message={(error as Error).message} onRetry={invalidate} />;
  if (!o) return null;

  const cur = o.currency;
  const canFulfill = o.state === 'Paid' || o.state === 'PartiallyRefunded';
  const canCancel = o.state === 'PendingPayment' || o.state === 'Paid';
  const canRefund = o.state === 'Paid' || o.state === 'PartiallyRefunded';
  const unfulfilledLines = o.lines.filter((l) => unfulfilled(l) > 0);
  const latestFulfillment = o.fulfillments[0];
  const canMarkDelivered = latestFulfillment?.state === 'Shipped';
  const canEditItems = o.state === 'PendingPayment' || o.state === 'Paid' || o.state === 'PartiallyRefunded';
  const canEditAddress = o.state !== 'Cancelled';
  const amountDue = o.amountDue ?? 0;

  return (
    <>
      {confirmDialog}
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Orders</Link>
      <PageHeader
        title={o.code}
        subtitle={dateTime(o.placedAt ?? o.createdAt)}
        actions={<div className="flex items-center gap-2">
          <StatusBadge value={o.state} />{latestFulfillment && <StatusBadge value={latestFulfillment.state} />}
          {amountDue > 0 && <StatusBadge value="balance_due" tone="attention" label="Balance due" />}
          {canEditItems && !editing && <button className="btn-ghost btn-sm" onClick={() => setEditing(true)}><Pencil size={13} /> Edit order</button>}
        </div>}
      />

      {(fulfill.error || cancel.error || refund.error) && <div className="mb-4"><InlineAlert tone="critical">{getErrorMessage(fulfill.error || cancel.error || refund.error)}</InlineAlert></div>}

      <div className="grid lg:grid-cols-3 gap-5">
        {/* Left: items + actions + timeline */}
        <div className="lg:col-span-2 space-y-5">
          {editing && <OrderEditPanel code={o.code} currency={cur} initialAddress={pendingAddress} onClose={() => { setEditing(false); setPendingAddress(null); }} onCommitted={afterEdit} />}
          {!editing && (<FormSection title="Items" description={`${o.lines.filter((l) => l.quantity > 0).length} line${o.lines.filter((l) => l.quantity > 0).length === 1 ? '' : 's'} on this order`}>
            <table className="w-full">
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.id} className="border-t border-gray-100 first:border-0">
                    <td className="td">
                      <div className={`font-medium ${l.quantity === 0 ? 'line-through text-gray-400' : ''}`}>{l.name}{l.quantity === 0 && <span className="ml-2 text-xs font-normal no-underline text-gray-400">removed by edit</span>}</div>
                      <div className="text-xs text-gray-400">{l.sku} · {money(l.unitPrice, cur)} × {l.quantity}
                        {l.fulfilledQty > 0 && <span className="text-success"> · {l.fulfilledQty} shipped</span>}
                        {l.refundedQty > 0 && <span className="text-danger"> · {l.refundedQty} refunded</span>}
                        {l.cancelledQty > 0 && <span className="text-gray-400"> · {l.cancelledQty} cancelled</span>}</div>
                    </td>
                    <td className="td text-right font-medium whitespace-nowrap">{money(l.lineTotal, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="space-y-1 text-sm pt-2">
              <Row label="Subtotal" value={money(o.subtotal, cur)} />
              {o.discountTotal > 0 && <Row label="Discount" value={`− ${money(o.discountTotal, cur)}`} />}
              <Row label={o.shippingMethodName ? `Shipping (${o.shippingMethodName})` : 'Shipping'} value={money(o.shippingTotal, cur)} />
              {o.taxTotal > 0 && <Row label="Tax" value={money(o.taxTotal, cur)} />}
              {(o.adjustments ?? []).map((a) => <Row key={a.id} label={a.label} value={`${a.amount < 0 ? '− ' : '+ '}${money(Math.abs(a.amount), cur)}`} />)}
              <div className="flex justify-between pt-1 border-t border-gray-100 mt-1 font-semibold">
                <span>Total</span><span>{money(o.grandTotal, cur)}</span>
              </div>
            </div>
          </FormSection>)}

          {/* Partial fulfillment */}
          <FormSection
            title="Fulfillment"
            description={canFulfill
              ? 'Select the lines and quantities shipping in this package. Multiple fulfillments are supported for split shipments.'
              : o.state === 'PendingPayment' ? 'Order is awaiting payment.' : `Order is ${o.state.toLowerCase()}; no fulfillment actions.`}
          >
            {canFulfill && unfulfilledLines.length > 0 ? (
              <div className="space-y-3">
                <table className="w-full">
                  <thead><tr><th className="th">Line</th><th className="th text-center" style={{ width: '9rem' }}>Ship qty</th></tr></thead>
                  <tbody>
                    {unfulfilledLines.map((l) => {
                      const max = unfulfilled(l);
                      return (
                        <tr key={l.id} className="border-t border-gray-100">
                          <td className="td">
                            <div className="font-medium">{l.name}</div>
                            <div className="text-xs text-gray-400">{l.sku} · {max} remaining</div>
                          </td>
                          <td className="td text-center">
                            <input
                              type="number" min={0} max={max} className="input w-20 text-center tnum py-1.5"
                              aria-label={`Ship quantity for ${l.sku}`}
                              value={fulfillQty[l.id] ?? ''}
                              onChange={(e) => setFulfillQty((m) => ({ ...m, [l.id]: e.target.value }))}
                              placeholder="0"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Tracking #"><input className="input" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="optional" /></Field>
                  <Field label="Carrier"><input className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="optional" /></Field>
                </div>
                {o.locations.length > 0 && (
                  <Field label="Ships from">
                    <select className="input" value={fulfillLocation} onChange={(e) => setFulfillLocation(e.target.value)} aria-label="Fulfillment location">
                      <option value="">No specific location</option>
                      {o.locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}{loc.isDefault ? ' (default)' : ''}</option>)}
                    </select>
                  </Field>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-brand" checked={notifyCustomer} onChange={(e) => setNotifyCustomer(e.target.checked)} />
                  Notify customer by email
                </label>
                <button className="btn-primary" disabled={fulfill.isPending} onClick={() => fulfill.mutate()}>
                  {fulfill.isPending ? <Spinner className="text-white" /> : <><Truck size={16} /> Create fulfillment</>}
                </button>
              </div>
            ) : canFulfill ? (
              <p className="text-sm text-gray-400">Every line has already shipped.</p>
            ) : null}

            {canMarkDelivered && (
              <div className="pt-2 border-t border-gray-100">
                <button className="btn-ghost" disabled={markDelivered.isPending} onClick={() => markDelivered.mutate()}>
                  {markDelivered.isPending ? <Spinner /> : <><CheckCircle2 size={16} /> Mark delivered</>}
                </button>
              </div>
            )}

            {o.fulfillments.length > 0 && (
              <div className="pt-2 border-t border-gray-100 space-y-2">
                {o.fulfillments.map((f) => {
                  const loc = o.locations.find((l) => l.id === f.locationId);
                  return (
                    <div key={f.id} className="text-xs text-gray-500 flex items-center justify-between gap-2 flex-wrap">
                      <span>
                        <StatusBadge value={f.state} />{' '}
                        {f.lines.length > 0 && `${f.lines.reduce((n, l) => n + l.quantity, 0)} item${f.lines.reduce((n, l) => n + l.quantity, 0) === 1 ? '' : 's'} · `}
                        {f.trackingCode ? `${f.carrier ?? ''} ${f.trackingCode} · ` : ''}
                        {loc ? `${loc.name} · ` : ''}
                        {f.notifyCustomer ? 'customer notified' : 'no customer email'}
                      </span>
                      <span>{dateTime(f.createdAt)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </FormSection>

          {/* Timeline (audit events + internal notes, same feed) */}
          <FormSection title="Timeline" description="Recent activity for this order, including staff-only notes">
            <div className="space-y-2">
              <div className="flex gap-2">
                <label className="sr-only" htmlFor="internal-note">Add an internal note</label>
                <input
                  id="internal-note" className="input flex-1" placeholder="Add an internal note (not visible to the customer)…"
                  value={noteText} onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && noteText.trim()) addNote.mutate(); }}
                />
                <button className="btn-ghost shrink-0" disabled={addNote.isPending || !noteText.trim()} onClick={() => addNote.mutate()}>
                  {addNote.isPending ? <Spinner /> : <><StickyNote size={15} /> Add note</>}
                </button>
              </div>
              {o.events.length > 0 && (
                <ul className="space-y-2 pt-1">
                  {o.events.map((e) => (
                    <li key={e.id} className="flex items-start gap-2 text-sm">
                      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${e.action === 'note' ? 'bg-brand' : 'bg-gray-300'}`} />
                      <span className="text-gray-600">
                        {e.action === 'note' ? (
                          <><span className="font-medium">Note:</span> {e.data?.note}</>
                        ) : e.action === 'edit' || e.action === 'edit_address' ? (
                          <><span className="font-medium">{e.action === 'edit' ? 'Order edited' : `${e.data?.kind === 'billing' ? 'Billing' : 'Shipping'} address edited`}</span>
                            {e.data?.reason ? `: ${e.data.reason}` : ''}
                            {e.data?.changes && e.data.changes.length > 0 && <span className="block text-xs text-gray-500">{e.data.changes.join(' · ')}</span>}</>
                        ) : (
                          <><span className="font-medium capitalize">{e.action.replace(/_/g, ' ')}</span>{e.toState && ` → ${e.toState}`}</>
                        )}
                        <span className="text-gray-400"> · {dateTime(e.at)}{e.actor ? ` · ${e.actor}` : ''}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </FormSection>
        </div>

        {/* Right: customer + payment + refund + danger */}
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

          <AddressCard code={o.code} kind="shipping" address={o.shippingAddress} canEdit={canEditAddress} hasCustomer={!!o.customer} onSaved={invalidate}
            onCountryChange={(form, saveToAddressBook) => { setPendingAddress({ form, saveToAddressBook }); setEditing(true); }} />
          <AddressCard code={o.code} kind="billing" address={o.billingAddress} canEdit={canEditAddress} hasCustomer={!!o.customer} onSaved={invalidate}
            onCountryChange={() => undefined} />

          <FormSection title="Payment">
            {amountDue > 0 && <InlineAlert tone="attention" title="Balance due">The customer still owes {money(amountDue, cur)} after an edit. Edit the order to send a pay link or record a payment.</InlineAlert>}
            {amountDue < 0 && <InlineAlert tone="info" title="Credit">{money(-amountDue, cur)} is owed back to the customer. Use Refund to return it.</InlineAlert>}
            {o.payments.length === 0 ? <span className="text-sm text-gray-400">No payments</span> : o.payments.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm py-1">
                <span className="capitalize text-gray-600">{p.method}</span>
                <span className="flex items-center gap-2"><StatusBadge value={p.state === 'Settled' ? 'Paid' : p.state} /> {money(p.amount, cur)}</span>
              </div>
            ))}
          </FormSection>

          {canRefund && (
            <FormSection title="Refund" description="Select lines to refund specific items (with per-line restock), or leave everything unchecked to refund the full remaining balance.">
              <div className="space-y-2">
                {o.lines.filter((l) => unrefunded(l) > 0).map((l) => {
                  const max = unrefunded(l);
                  return (
                    <div key={l.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="number" min={0} max={max} className="input w-16 text-center tnum py-1"
                        aria-label={`Refund quantity for ${l.sku}`}
                        value={refundQty[l.id] ?? ''}
                        onChange={(e) => setRefundQty((m) => ({ ...m, [l.id]: e.target.value }))}
                        placeholder="0"
                      />
                      <span className="flex-1 min-w-0 truncate text-gray-600">{l.name} <span className="text-gray-400">({max} left)</span></span>
                      <label className="flex items-center gap-1 text-xs text-gray-500 shrink-0">
                        <input
                          type="checkbox" className="h-3.5 w-3.5 accent-brand"
                          checked={!!refundRestock[l.id]}
                          onChange={(e) => setRefundRestock((m) => ({ ...m, [l.id]: e.target.checked }))}
                        /> Restock
                      </label>
                    </div>
                  );
                })}
              </div>
              <Field label={`Shipping refund (${cur})`} hint="Optional — refunded separately from the item total">
                <input className="input" inputMode="decimal" value={shippingAmt} onChange={(e) => setShippingAmt(e.target.value)} placeholder="0.00" disabled={refundLineSelection.length === 0} />
              </Field>
              <Field label="Reason" hint="Optional — shown in the refund history">
                <textarea className="input" rows={2} value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="e.g. damaged in transit" />
              </Field>
              {refundLineSelection.length > 0 && (
                <div className="text-sm text-gray-600 flex justify-between pt-1 border-t border-gray-100">
                  <span>Computed total</span><span className="font-semibold tnum">{money(refundComputedTotal, cur)}</span>
                </div>
              )}
              <div className="pt-2">
                <button
                  className="btn-danger" disabled={refund.isPending}
                  onClick={async () => {
                    const label = refundLineSelection.length > 0 ? money(refundComputedTotal, cur) : 'the full remaining balance';
                    if (await confirm({ title: 'Issue this refund?', description: `This will refund ${label}.`, tone: 'danger', confirmLabel: 'Issue refund' })) refund.mutate();
                  }}
                >
                  {refund.isPending ? <Spinner /> : 'Issue refund'}
                </button>
              </div>

              {o.refunds.length > 0 && (
                <div className="pt-3 mt-1 border-t border-gray-100 space-y-2">
                  {o.refunds.map((r) => (
                    <div key={r.id} className="text-xs text-gray-500">
                      <div className="flex items-center justify-between">
                        <span><StatusBadge value={r.state} /> {money(r.amount, cur)}</span>
                        <span>{dateTime(r.createdAt)}</span>
                      </div>
                      {(r.itemsAmount != null || r.shippingAmount) ? (
                        <div className="text-gray-400">items {money(r.itemsAmount ?? 0, cur)}{r.shippingAmount ? ` + shipping ${money(r.shippingAmount, cur)}` : ''}</div>
                      ) : null}
                      {r.reason && <div className="text-gray-400">reason: {r.reason}</div>}
                      {r.lines.some((l) => l.restock) && <div className="text-gray-400">restocked {r.lines.filter((l) => l.restock).reduce((n, l) => n + l.quantity, 0)} item(s)</div>}
                    </div>
                  ))}
                </div>
              )}
            </FormSection>
          )}

          {canCancel && (
            <div className="border-danger/30 [&>section]:border-danger/30">
              <FormSection title="Danger zone" description="Cancelling releases reserved stock. Refund must be issued separately.">
                <button
                  className="btn-danger" disabled={cancel.isPending}
                  onClick={async () => { if (await confirm({ title: `Cancel order ${o.code}?`, description: 'Stock will be released.', tone: 'danger', confirmLabel: 'Cancel order' })) cancel.mutate(); }}
                >
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
