import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Minus, Plus, Repeat, Search, X } from 'lucide-react';
import { api, ApiError } from '../../api';
import { useToast } from '../Toast';
import { money } from '../../lib/format';
import { FormSection, Field, InlineAlert, Spinner, Loading, ErrorState } from '../ui';
import { buildOps, parseCents, refundSelection, WARNING_TEXT } from './ops';
import {
  emptyStaged, type AddressForm, type CommitResponse, type EditContext, type Preview, type SettlementChoice, type StagedEdit,
} from './types';
import { addressLines } from './AddressCard';

type VariantHit = { sku: string; name: string; productName: string; unitPrice: number; available: number | null };

const signed = (cents: number, cur: string) => `${cents < 0 ? '−' : '+'}${money(Math.abs(cents), cur)}`;

/** Variant search used by "Add item" and "Swap variant". */
function VariantPicker({ code, onPick, placeholder }: { code: string; onPick: (v: VariantHit) => void; placeholder: string }) {
  const [q, setQ] = useState('');
  // No debounce: results carry live availability, which must never be a delayed read.
  const dq = q.trim();
  const { data, isFetching } = useQuery({
    queryKey: ['order-edit-variants', code, dq],
    queryFn: () => api.get<{ items: VariantHit[] }>(`/orders/${encodeURIComponent(code)}/edit/variants?q=${encodeURIComponent(dq)}`),
    enabled: dq.length > 0,
    staleTime: 0,
    gcTime: 0,
  });
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
        <input className="input pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      </div>
      {dq && (
        <div className="rounded-lg border border-gray-100 divide-y divide-gray-100 max-h-48 overflow-y-auto">
          {isFetching && !data ? <div className="p-2 text-xs text-gray-400">Searching…</div> : (data?.items.length ?? 0) === 0 ? <div className="p-2 text-xs text-gray-400">No matching variants</div> : data!.items.map((v) => (
            <button type="button" key={v.sku} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex justify-between gap-3" onClick={() => { onPick(v); setQ(''); }}>
              <span className="min-w-0 truncate">{v.productName} — {v.name} <span className="text-xs text-gray-400">{v.sku}</span></span>
              <span className="shrink-0 tnum text-gray-500">{v.available != null ? `${v.available} avail · ` : ''}{money(v.unitPrice)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Shopify-style order edit (G13). Changes are STAGED in this page; the server
 * previews them (new totals, per-line diff, stock check, balance) on every
 * change, and Commit applies them atomically with a settlement choice for the
 * balance. Quantities already shipped or refunded are locked.
 */
export function OrderEditPanel({ code, currency, initialAddress, onClose, onCommitted }: {
  code: string; currency: string;
  initialAddress?: { form: AddressForm; saveToAddressBook: boolean } | null;
  onClose: () => void; onCommitted: () => void;
}) {
  const toast = useToast();
  const ctxQ = useQuery({ queryKey: ['order-edit-context', code], queryFn: () => api.get<EditContext>(`/orders/${encodeURIComponent(code)}/edit/context`) });
  const [st, setSt] = useState<StagedEdit>(() => {
    const s0 = emptyStaged();
    if (initialAddress) s0.address = { shipping: initialAddress.form, saveToAddressBook: initialAddress.saveToAddressBook };
    return s0;
  });
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [settlementType, setSettlementType] = useState<SettlementChoice['type'] | ''>('');
  const [refundPaymentId, setRefundPaymentId] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'zelle' | 'check' | 'card_phone' | 'other'>('cash');
  const [payRef, setPayRef] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState('');
  const [adjLabel, setAdjLabel] = useState('');
  const [adjAmount, setAdjAmount] = useState('');
  const [customShip, setCustomShip] = useState('');

  const ctx = ctxQ.data;
  const ops = useMemo(() => (ctx ? buildOps(ctx, st) : []), [ctx, st]);
  const opsKey = JSON.stringify(ops);
  // The preview includes the live stock check: no debounce, no cache.
  const dOpsKey = opsKey;

  const preview = useQuery({
    queryKey: ['order-edit-preview', code, dOpsKey],
    queryFn: () => api.post<Preview>(`/orders/${encodeURIComponent(code)}/edit/preview`, { ops: JSON.parse(dOpsKey) }),
    enabled: !!ctx && ops.length > 0,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const pv = preview.data ?? null;
  const due = pv?.balance.amountDue ?? 0;
  // The settlement choices depend on the balance's sign; a flip invalidates the choice.
  const dueSign = Math.sign(due);
  useEffect(() => { setSettlementType(''); }, [dueSign]);

  // A changed edit invalidates the settlement choice and the idempotency key.
  const keyRef = useRef<{ sig: string; key: string }>({ sig: '', key: '' });
  const settlement = useMemo((): SettlementChoice | undefined => {
    if (!pv || due === 0) return undefined;
    if (settlementType === 'refund_now') return { type: 'refund_now', paymentId: refundPaymentId || (pv.refund?.payments.length === 1 ? pv.refund.payments[0]!.id : undefined) };
    if (settlementType === 'leave_credit') return { type: 'leave_credit' };
    if (settlementType === 'send_pay_link') return { type: 'send_pay_link' };
    if (settlementType === 'leave_due') return { type: 'leave_due' };
    if (settlementType === 'record_payment') {
      const amt = payAmount.trim() ? parseCents(payAmount) : null;
      return { type: 'record_payment', method: payMethod, reference: payRef.trim() || undefined, ...(amt != null ? { amount: amt } : {}) };
    }
    return undefined;
  }, [pv, due, settlementType, refundPaymentId, payMethod, payRef, payAmount]);

  const commit = useMutation({
    mutationFn: () => {
      const sig = JSON.stringify({ ops, settlement, reason, notify, total: pv!.after.grandTotal });
      if (keyRef.current.sig !== sig) keyRef.current = { sig, key: crypto.randomUUID() };
      return api.post<CommitResponse>(`/orders/${encodeURIComponent(code)}/edit/commit`, {
        ops, expectedGrandTotal: pv!.after.grandTotal, expectedBalance: pv!.balance.amountDue, idempotencyKey: keyRef.current.key,
        settlement, notifyCustomer: notify, reason: reason.trim() || undefined,
      });
    },
    onSuccess: (r) => {
      const s = r.settlement;
      if (s.status === 'failed') toast.error('Order updated, but the refund failed', s.message ?? 'Retry it from the edit history below.');
      else toast.success(r.replay ? 'Edit already applied' : 'Order updated', s.type === 'refund_now' ? `Refund ${s.status}` : s.type === 'send_pay_link' ? 'Pay link sent to the customer' : undefined);
      onCommitted();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PREVIEW_STALE') { toast.error('Order changed — preview refreshed', 'Review the new totals and commit again.'); preview.refetch(); return; }
      toast.error('Edit failed', e instanceof Error ? e.message : 'unexpected error');
    },
  });

  if (ctxQ.isLoading) return <Loading />;
  if (ctxQ.error || !ctx) return <ErrorState title="Couldn't load the edit session" message={(ctxQ.error as Error)?.message ?? ''} onRetry={() => ctxQ.refetch()} />;
  if (!ctx.editable.items) {
    return (
      <FormSection title="Edit order" description={ctx.editable.blockedReason ?? 'This order cannot be edited.'}>
        <button className="btn-ghost" onClick={onClose}>Close</button>
      </FormSection>
    );
  }

  const diffFor = (id: string) => pv?.lines.find((l) => l.lineId === id);
  const refundSel = refundSelection(pv?.refund ?? null, -due, settlement?.type === 'refund_now' ? (settlement.paymentId ?? '') : '');
  const needsSettlement = !!pv && due !== 0;
  const canCommit = !!pv && ops.length > 0 && pv.stockOk && (!needsSettlement || !!settlement)
    && !(settlementType === 'record_payment' && payAmount.trim() !== '' && parseCents(payAmount) == null)
    && !(settlement?.type === 'refund_now' && !refundSel.ok)
    && !(settlement?.type === 'send_pay_link' && !pv.recipientEmail);
  const set = (patch: Partial<StagedEdit>) => setSt((s) => ({ ...s, ...patch }));

  const removeLine = (id: string, min: number) => set({ qty: { ...st.qty, [id]: min } });

  return (
    <div className="space-y-5">
      <FormSection title="Edit order" description="Stage changes below. Totals, stock and the balance update as you go; nothing is saved until you commit.">
        <table className="w-full">
          <thead><tr><th className="th">Item</th><th className="th text-center" style={{ width: '8rem' }}>Qty</th><th className="th text-right">Total</th><th className="th" style={{ width: '5rem' }} /></tr></thead>
          <tbody>
            {ctx.lines.map((l) => {
              const q = st.qty[l.id] ?? l.quantity;
              const d = diffFor(l.id);
              const swap = st.swaps[l.id];
              const removed = q === l.minQuantity && l.quantity > l.minQuantity;
              return (
                <tr key={l.id} className="border-t border-gray-100 align-top">
                  <td className="td">
                    <div className={`font-medium ${removed || (q === 0) ? 'line-through text-gray-400' : ''}`}>{swap ? `${l.name} → ${swap.name}` : l.name}</div>
                    <div className="text-xs text-gray-400">{l.sku} · {money(l.unitPrice, currency)}
                      {l.fulfilledQty > 0 && <span className="text-success"> · {l.fulfilledQty} shipped (locked)</span>}
                      {l.refundedQty > 0 && <span className="text-danger"> · {l.refundedQty} refunded (locked)</span>}
                    </div>
                    {swapFor === l.id && (
                      <div className="mt-2"><VariantPicker code={code} placeholder="Search a variant to swap to…" onPick={(v) => { set({ swaps: { ...st.swaps, [l.id]: { sku: v.sku, name: v.name } } }); setSwapFor(null); }} /></div>
                    )}
                  </td>
                  <td className="td text-center">
                    <div className="inline-flex items-center gap-1">
                      <button type="button" className="btn-ghost btn-sm" aria-label={`Decrease quantity of ${l.sku}`} disabled={q <= l.minQuantity} onClick={() => set({ qty: { ...st.qty, [l.id]: q - 1 } })}><Minus size={12} /></button>
                      <input type="number" min={l.minQuantity} className="input w-16 text-center tnum py-1" aria-label={`Quantity of ${l.sku}`} value={q}
                        onChange={(e) => { const n = Math.max(l.minQuantity, Math.floor(Number(e.target.value) || 0)); set({ qty: { ...st.qty, [l.id]: n } }); }} />
                      <button type="button" className="btn-ghost btn-sm" aria-label={`Increase quantity of ${l.sku}`} onClick={() => set({ qty: { ...st.qty, [l.id]: q + 1 } })}><Plus size={12} /></button>
                    </div>
                    {l.minQuantity > 0 && <div className="text-[11px] text-gray-400 mt-0.5">min {l.minQuantity}</div>}
                  </td>
                  <td className="td text-right whitespace-nowrap tnum">
                    {d && d.afterTotal !== d.beforeTotal ? <><span className="text-gray-400 line-through mr-1">{money(d.beforeTotal, currency)}</span>{money(d.afterTotal, currency)}</> : money(l.lineTotal, currency)}
                  </td>
                  <td className="td text-right whitespace-nowrap">
                    <button type="button" className="btn-ghost btn-sm" aria-label={`Swap variant of ${l.sku}`} disabled={l.quantity - l.minQuantity <= 0} onClick={() => setSwapFor(swapFor === l.id ? null : l.id)}><Repeat size={12} /></button>
                    <button type="button" className="btn-ghost btn-sm" aria-label={`Remove ${l.sku}`} disabled={l.quantity - l.minQuantity <= 0} onClick={() => removeLine(l.id, l.minQuantity)}><X size={12} /></button>
                  </td>
                </tr>
              );
            })}
            {st.adds.map((a, i) => {
              const d = pv?.lines.find((x) => x.lineId == null && x.sku === a.sku);
              return (
                <tr key={`add-${i}`} className="border-t border-gray-100 bg-gray-50/60">
                  <td className="td"><div className="font-medium">{a.name}</div><div className="text-xs text-gray-400">{a.sku} · new item</div></td>
                  <td className="td text-center">
                    <input type="number" min={1} className="input w-16 text-center tnum py-1" aria-label={`Quantity of added ${a.sku}`} value={a.quantity}
                      onChange={(e) => set({ adds: st.adds.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) } : x)) })} />
                  </td>
                  <td className="td text-right tnum">{d ? money(d.afterTotal, currency) : '—'}</td>
                  <td className="td text-right"><button type="button" className="btn-ghost btn-sm" aria-label={`Remove added ${a.sku}`} onClick={() => set({ adds: st.adds.filter((_, j) => j !== i) })}><X size={12} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <VariantPicker code={code} placeholder="Add an item — search by name or SKU" onPick={(v) => set({ adds: [...st.adds, { sku: v.sku, name: `${v.productName} — ${v.name}`, quantity: 1 }] })} />
      </FormSection>

      <FormSection title="Discount, shipping & adjustments">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Coupon" hint={pv?.promotion ? `Applied: ${pv.promotion.code ?? 'automatic'} (${pv.promotion.type === 'percentage' ? `${pv.promotion.value}%` : pv.promotion.type === 'fixed' ? money(pv.promotion.value, currency) : 'free shipping'})` : 'No coupon on this order'}>
            <div className="flex gap-2">
              <input className="input" value={couponInput} onChange={(e) => setCouponInput(e.target.value)} placeholder="Code" aria-label="Coupon code" />
              <button type="button" className="btn-ghost shrink-0" disabled={!couponInput.trim()} onClick={() => { set({ coupon: { mode: 'apply', code: couponInput.trim() } }); }}>Apply</button>
              <button type="button" className="btn-ghost shrink-0" onClick={() => { set({ coupon: { mode: 'remove', code: '' } }); setCouponInput(''); }}>Remove</button>
            </div>
            {st.coupon.mode !== 'keep' && <div className="mt-1 text-xs text-gray-500">{st.coupon.mode === 'remove' ? 'Coupon will be removed.' : `Will apply ${st.coupon.code}.`} <button type="button" className="underline" onClick={() => set({ coupon: { mode: 'keep', code: '' } })}>undo</button></div>}
          </Field>
          <Field label="Shipping" hint={`Currently ${money(ctx.shipping.amount, currency)}${ctx.shipping.override ? ' (custom)' : ''}`}>
            <select className="input" aria-label="Shipping" value={st.shipping.mode === 'method' ? `m:${st.shipping.code}` : st.shipping.mode}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'keep') set({ shipping: { mode: 'keep', code: '', amountCents: 0 } });
                else if (v === 'custom') set({ shipping: { mode: 'custom', code: '', amountCents: parseCents(customShip) ?? 0 } });
                else if (v === 'none') set({ shipping: { mode: 'none', code: '', amountCents: 0 } });
                else set({ shipping: { mode: 'method', code: v.slice(2), amountCents: 0 } });
              }}>
              <option value="keep">Keep current</option>
              {ctx.shippingMethods.map((m) => <option key={m.code} value={`m:${m.code}`}>{m.name} — {money(m.rate, currency)}</option>)}
              <option value="custom">Custom amount…</option>
              <option value="none">Remove shipping</option>
            </select>
            {st.shipping.mode === 'custom' && (
              <input className="input mt-2" inputMode="decimal" aria-label="Custom shipping amount" placeholder="0.00" value={customShip}
                onChange={(e) => { setCustomShip(e.target.value); set({ shipping: { mode: 'custom', code: '', amountCents: parseCents(e.target.value) ?? 0 } }); }} />
            )}
          </Field>
        </div>
        <div>
          <div className="label">Adjustments</div>
          <ul className="space-y-1 mb-2">
            {ctx.adjustments.map((a) => {
              const gone = st.adjRemove.includes(a.id);
              return (
                <li key={a.id} className={`flex items-center justify-between text-sm ${gone ? 'line-through text-gray-400' : 'text-gray-600'}`}>
                  <span>{a.label}</span>
                  <span className="flex items-center gap-2 tnum">{signed(a.amount, currency)}
                    <button type="button" className="btn-ghost btn-sm" aria-label={`${gone ? 'Restore' : 'Remove'} adjustment ${a.label}`} onClick={() => set({ adjRemove: gone ? st.adjRemove.filter((x) => x !== a.id) : [...st.adjRemove, a.id] })}>{gone ? 'Undo' : <X size={12} />}</button>
                  </span>
                </li>
              );
            })}
            {st.adjAdd.map((a, i) => (
              <li key={`n${i}`} className="flex items-center justify-between text-sm text-gray-600">
                <span>{a.label} <span className="text-xs text-gray-400">(new)</span></span>
                <span className="flex items-center gap-2 tnum">{signed(a.amountCents, currency)}
                  <button type="button" className="btn-ghost btn-sm" aria-label={`Remove new adjustment ${a.label}`} onClick={() => set({ adjAdd: st.adjAdd.filter((_, j) => j !== i) })}><X size={12} /></button></span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input className="input" placeholder="Label (e.g. Goodwill credit)" aria-label="Adjustment label" value={adjLabel} onChange={(e) => setAdjLabel(e.target.value)} />
            <input className="input w-32" inputMode="decimal" placeholder="+/- 0.00" aria-label="Adjustment amount" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} />
            <button type="button" className="btn-ghost shrink-0" disabled={!adjLabel.trim() || !parseCents(adjAmount)}
              onClick={() => { set({ adjAdd: [...st.adjAdd, { label: adjLabel.trim(), amountCents: parseCents(adjAmount)! }] }); setAdjLabel(''); setAdjAmount(''); }}>Add</button>
          </div>
          <p className="mt-1 text-xs text-gray-400">A positive amount charges the customer, a negative one credits them. Adjustments are not taxed.</p>
        </div>
        {(st.address.shipping || st.address.billing) && (
          <div className="rounded-lg border border-gray-100 p-3 text-sm">
            <div className="font-medium mb-1">Address change</div>
            {(['shipping', 'billing'] as const).map((k) => st.address[k] && (
              <div key={k} className="text-gray-600 flex justify-between gap-2"><span>{k}: {addressLines(st.address[k] as unknown as Record<string, unknown>).join(', ')}</span>
                <button type="button" className="underline text-xs" onClick={() => set({ address: { ...st.address, [k]: undefined } })}>discard</button></div>
            ))}
          </div>
        )}
      </FormSection>

      {ops.length > 0 && (
        <FormSection title="Review and settle" description="What this edit does to the order, and how to settle the difference.">
          {preview.error ? <InlineAlert tone="critical">{(preview.error as Error).message}</InlineAlert> : !pv ? <Loading label="Calculating" /> : (
            <div className="space-y-4">
              {pv.warnings.map((w) => <InlineAlert key={w} tone="attention">{WARNING_TEXT[w] ?? w}</InlineAlert>)}
              {pv.address.shipping.countryChanged && <InlineAlert tone="info">The shipping country changed, so tax and shipping eligibility were recalculated.</InlineAlert>}
              {!pv.stockOk && <InlineAlert tone="critical">Not enough stock: {pv.stock.filter((x) => !x.ok).map((x) => `${x.sku} (need ${x.delta}, ${x.available ?? 0} available)`).join(', ')}.</InlineAlert>}
              <ul className="text-sm space-y-1">
                {pv.lines.filter((l) => l.change !== 'unchanged').map((l, i) => (
                  <li key={i} className="flex justify-between gap-3 text-gray-600">
                    <span>{l.change === 'added' ? `Add ${l.afterQty} × ${l.name}` : l.change === 'removed' ? `Remove ${l.name}` : l.change === 'swapped' ? `Swap ${l.fromSku} → ${l.name}` : l.change === 'quantity' ? `${l.name}: ${l.beforeQty} → ${l.afterQty}` : `${l.name}: repriced`}</span>
                    <span className="tnum">{signed(l.afterTotal - l.beforeTotal, currency)}</span>
                  </li>
                ))}
                {pv.stock.filter((x) => x.delta !== 0).map((x) => <li key={x.sku} className="text-xs text-gray-400">Stock {x.sku}: {x.delta > 0 ? `reserve ${x.delta}` : `release ${-x.delta}`}</li>)}
              </ul>
              <div className="space-y-1 text-sm border-t border-gray-100 pt-2">
                {([['Subtotal', 'subtotal'], ['Discount', 'discountTotal'], ['Shipping', 'shippingTotal'], ['Tax', 'taxTotal'], ['Adjustments', 'adjustmentTotal']] as const).map(([label, k]) => (
                  (pv.before[k] !== 0 || pv.after[k] !== 0) && <div key={k} className="flex justify-between text-gray-600"><span>{label}</span><span className="tnum">{pv.before[k] !== pv.after[k] && <span className="text-gray-400 line-through mr-2">{money(pv.before[k], currency)}</span>}{money(pv.after[k], currency)}</span></div>
                ))}
                <div className="flex justify-between font-semibold pt-1 border-t border-gray-100"><span>New total</span><span className="tnum">{money(pv.after.grandTotal, currency)}</span></div>
                <div className="flex justify-between text-gray-600"><span>Paid so far (net of refunds)</span><span className="tnum">{money(pv.balance.netPaid, currency)}</span></div>
                <div className={`flex justify-between font-semibold ${due > 0 ? 'text-danger' : due < 0 ? 'text-success' : ''}`}>
                  <span>{due > 0 ? 'Balance due from customer' : due < 0 ? 'Owed back to customer' : 'Balance'}</span><span className="tnum">{money(Math.abs(due), currency)}</span>
                </div>
              </div>

              {due !== 0 && (
                <fieldset className="space-y-2">
                  <legend className="label">{due > 0 ? 'How will the customer pay?' : 'How do you want to return the difference?'}</legend>
                  {(due < 0 ? [
                    ['refund_now', `Refund ${money(-due, currency)} now`],
                    ['leave_credit', 'Leave as credit on the order (no refund yet)'],
                  ] : [
                    ['send_pay_link', `Email a pay link for ${money(due, currency)}`],
                    ['record_payment', 'Record a payment I already received'],
                    ['leave_due', 'Leave the balance due (decide later)'],
                  ]).map(([v, label]) => (
                    <label key={v} className="flex items-start gap-2 text-sm">
                      <input type="radio" name="settlement" className="mt-1 accent-brand" checked={settlementType === v} onChange={() => setSettlementType(v as SettlementChoice['type'])} disabled={v === 'refund_now' && !refundSel.selectable} />
                      <span>{label}{v === 'refund_now' && !refundSel.selectable && <span className="block text-xs text-danger">{refundSel.reason}</span>}
                        {v === 'send_pay_link' && !pv.recipientEmail && <span className="block text-xs text-danger">This order has no customer email.</span>}</span>
                    </label>
                  ))}
                  {settlementType === 'refund_now' && pv.refund && pv.refund.payments.length > 1 && (
                    <Field label="Refund to payment">
                      <select className="input" value={refundPaymentId} onChange={(e) => setRefundPaymentId(e.target.value)} aria-label="Refund to payment">
                        <option value="">Select a payment…</option>
                        {pv.refund.payments.map((p) => <option key={p.id} value={p.id}>{p.method} — {money(p.available, currency)} refundable</option>)}
                      </select>
                      {!refundSel.ok && refundSel.reason && <span className="block text-xs text-danger mt-1" role="alert">{refundSel.reason}</span>}
                    </Field>
                  )}
                  {settlementType === 'record_payment' && (
                    <div className="grid grid-cols-3 gap-2">
                      <Field label="Method"><select className="input" value={payMethod} onChange={(e) => setPayMethod(e.target.value as typeof payMethod)} aria-label="Payment method">
                        <option value="cash">Cash</option><option value="zelle">Zelle</option><option value="check">Check</option><option value="card_phone">Card (phone)</option><option value="other">Other</option>
                      </select></Field>
                      <Field label="Reference"><input className="input" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="Check # / confirmation" aria-label="Payment reference" /></Field>
                      <Field label="Amount" hint={`Blank = ${money(due, currency)}`}><input className="input" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} aria-label="Payment amount" /></Field>
                    </div>
                  )}
                </fieldset>
              )}

              <Field label="Reason" hint="Recorded on the order timeline (and shown to the customer in the update email)">
                <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer asked to add a second blade" />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-brand" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                Email the customer an order-updated summary{pv.recipientEmail ? ` (${pv.recipientEmail})` : ''}
              </label>
              <div className="flex gap-2">
                <button className="btn-primary" disabled={!canCommit || commit.isPending} onClick={() => commit.mutate()}>{commit.isPending ? <Spinner className="text-white" /> : 'Commit changes'}</button>
                <button className="btn-ghost" onClick={onClose} disabled={commit.isPending}>Discard</button>
              </div>
            </div>
          )}
        </FormSection>
      )}
      {ops.length === 0 && <button className="btn-ghost" onClick={onClose}>Cancel editing</button>}
    </div>
  );
}
