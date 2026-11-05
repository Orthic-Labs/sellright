import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Truck, CheckCircle2, Mail, MoreHorizontal, XCircle, Pencil, FileText, Package, ChevronDown } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { money, dateTime } from '../lib/format';
import { openOrderDocument } from '../lib/order-documents';
import { OrderEditPanel } from '../components/order-edit/OrderEditPanel';
import { EditHistory } from '../components/order-edit/EditHistory';
import { AddressCard } from '../components/order-edit/AddressCard';
import type { AddressForm } from '../components/order-edit/types';
import { FulfilDialog } from '../redesign/FulfilDialog';
import { RefundDialog } from '../redesign/RefundDialog';
import { CancelDialog } from '../redesign/CancelDialog';
import { LoadError, LoadingRows } from '../redesign/states';
import {
  canShip, canShipState, doneCopy, eventCopy, fulfilmentPill, isPre, openQty, paidTotal, paymentPill, plural, refundable, refundedTotal,
  type OrderLine, type OrderView,
} from '../redesign/order-model';

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'An unexpected error occurred';
}

type Dlg = 'fulfil' | 'refund' | 'cancel' | null;

export default function OrderDetailPage() {
  const { code = '' } = useParams();
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();

  const { data: o, isLoading, error, refetch } = useQuery({
    queryKey: ['order', store?.slug, code],
    queryFn: () => api.get<OrderView>(`/orders/${encodeURIComponent(code)}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['order', store?.slug, code] });

  // ── dialogs; focus returns to whatever opened them ───────────────────────
  const [dlg, setDlg] = useState<Dlg>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const moreBtn = useRef<HTMLButtonElement | null>(null);
  // Whatever opened a dialog may be gone by the time it closes (e.g. the last unfulfilled card); land on the heading then.
  const closeDlg = () => {
    setDlg(null);
    setTimeout(() => { if (document.activeElement === document.body || !document.activeElement) document.querySelector<HTMLElement>('.rd h1')?.focus(); }, 50);
  };
  const openDlg = (d: Exclude<Dlg, null>, from?: HTMLElement | null) => { trigger.current = from ?? (document.activeElement as HTMLElement | null); setDlg(d); };

  // ── order editing + direct address edit ──────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [pendingAddress, setPendingAddress] = useState<{ form: AddressForm; saveToAddressBook: boolean } | null>(null);
  const afterEdit = () => {
    setEditing(false); setPendingAddress(null); void invalidate();
    void qc.invalidateQueries({ queryKey: ['order-edit-context', code] });
  };

  const markDelivered = useMutation({
    mutationFn: () => api.post(`/orders/${encodeURIComponent(code)}/fulfill`, { state: 'Delivered' }),
    onSuccess: () => { void invalidate(); toast.success('Order marked delivered'); },
    onError: (e) => toast.error('Failed', getErrorMessage(e)),
  });

  const [noteText, setNoteText] = useState('');
  const addNote = useMutation({
    mutationFn: () => api.post(`/orders/${encodeURIComponent(code)}/notes`, { note: noteText.trim() }),
    onSuccess: () => { void invalidate(); setNoteText(''); toast.success('Note added'); },
    onError: (e) => toast.error('Could not add note', getErrorMessage(e)),
  });

  if (isLoading) return <div className="rd"><div className="card" style={{ margin: 24 }}><LoadingRows label="Loading order" rows={8} /></div></div>;
  if (error || !o) return <div className="rd" style={{ padding: 24 }}><LoadError what="this order" detail={error ? (error as Error).message : undefined} onRetry={() => void refetch()} /></div>;

  const cur = o.currency;
  const cancelled = o.state === 'Cancelled';
  const canRefund = o.state === 'Paid' || o.state === 'PartiallyRefunded' || (o.state === 'Refunded' && !!o.hasPostedCredit && o.lines.some((l) => refundable(l) > 0));
  const canCancel = o.state === 'PendingPayment' || o.state === 'Paid' || o.state === 'PartiallyRefunded';
  const canEditItems = o.state === 'PendingPayment' || o.state === 'Paid' || o.state === 'PartiallyRefunded';
  const canEditAddress = !cancelled;
  const [pTone, pLabel] = paymentPill(o);
  const [fTone, fLabel] = fulfilmentPill(o);
  const amountDue = o.amountDue;

  const unf = cancelled ? [] : o.lines.filter((l) => !isPre(l) && openQty(l) > 0);
  const pre = cancelled ? [] : o.lines.filter((l) => isPre(l) && openQty(l) > 0);
  const removed = o.lines.filter((l) => l.cancelledQty > 0);
  const shipNow = canShip(o);
  const nothingLeft = !cancelled && o.state !== 'PendingPayment' && unf.length === 0 && pre.length === 0;
  // Same order as the server (orders/recipient.ts): the checkout contact wins, the account email is the fallback.
  const email = o.contact?.email || o.customer?.email;
  const paid = paidTotal(o), refunded = refundedTotal(o);
  const sub = o.lines.reduce((s, l) => s + l.lineTotal, 0);
  const locName = (id: string | null) => o.locations.find((l) => l.id === id)?.name;
  const latest = o.fulfillments[0];

  const openDoc = (kind: 'invoice' | 'packing-slip') => {
    openOrderDocument(o.code, kind).catch((e) => toast.error(kind === 'invoice' ? 'Could not open the invoice' : 'Could not open the packing slip', getErrorMessage(e)));
  };

  const row = (l: OrderLine, q: number) => (
    <tr key={l.id}>
      <td>
        <div style={{ fontWeight: 500 }}>{l.name}</div>
        <div className="muted" style={{ fontSize: 12 }}><span className="mono">{l.sku}</span></div>
      </td>
      <td className="num muted" style={{ whiteSpace: 'nowrap' }}>{money(l.unitPrice, cur)} × {q}</td>
      <td className="num" style={{ padding: '0 16px', fontWeight: 500 }}>{money(l.unitPrice * q, cur)}</td>
    </tr>
  );
  const rows = (ls: OrderLine[], q: (l: OrderLine) => number) => <table className="ltab"><tbody>{ls.map((l) => row(l, q(l)))}</tbody></table>;

  return (
    <div className="rd">
      <div className="ph" style={{ paddingBottom: 4 }}>
        <Link to="/orders" className="btn ghost sm"><ArrowLeft aria-hidden="true" />Orders</Link>
      </div>
      <div className="ph" style={{ paddingTop: 0, flexWrap: 'wrap' }}>
        <h1 tabIndex={-1} style={{ font: '600 18px var(--mono)', outlineOffset: 4 }}>{o.code}</h1>
        <span className={`pill ${pTone}`}>{pLabel}</span>
        <span className={`pill ${fTone}`}>{fLabel}</span>
        {amountDue != null && amountDue > 0 && <span className="pill warn">Balance due</span>}
        <span className="meta">{dateTime(o.placedAt ?? o.createdAt)}</span>
        <span className="sp" />
        {shipNow && !editing && (
          <button type="button" className="btn pri" onClick={(e) => openDlg('fulfil', e.currentTarget)}><Truck aria-hidden="true" />Fulfil items…</button>
        )}
        <button type="button" className="btn" disabled={!canRefund || editing} title={canRefund ? undefined : 'Nothing to refund'} onClick={(e) => openDlg('refund', e.currentTarget)}>Refund…</button>
        <MoreMenu btnRef={moreBtn} items={[
          ...(canEditItems && !editing ? [{ label: 'Edit order', icon: <Pencil aria-hidden="true" />, run: () => setEditing(true) }] : []),
          { label: 'Invoice', icon: <FileText aria-hidden="true" />, run: () => openDoc('invoice') },
          { label: 'Packing slip', icon: <Package aria-hidden="true" />, run: () => openDoc('packing-slip') },
          ...(canCancel ? [{ label: 'Cancel order…', icon: <XCircle aria-hidden="true" />, danger: true, run: () => openDlg('cancel', moreBtn.current) }] : []),
        ]} />
      </div>

      <div className="grid2">
        <div className="stack">
          {cancelled && (
            <div className="banner" style={{ borderColor: 'rgb(var(--text-subtle))', background: 'rgb(var(--surface-2))' }}>
              <XCircle size={16} aria-hidden="true" />
              <div><b>Cancelled.</b> {refunded > 0 ? `${money(refunded, cur)} refunded.` : 'Payment was not refunded.'}{o.fulfillments.length ? " Shipped parcels below were not recalled." : ''}</div>
            </div>
          )}
          {editing && <OrderEditPanel code={o.code} currency={cur} initialAddress={pendingAddress} onClose={() => { setEditing(false); setPendingAddress(null); }} onCommitted={afterEdit} />}
          <EditHistory code={o.code} currency={cur} payments={o.payments} onChanged={afterEdit} />

          {o.state === 'PendingPayment' && o.lines.some((l) => openQty(l) > 0) && (
            <Card title="Awaiting payment" pill={<span className="pill neu nodot">{plural(o.lines.reduce((n, l) => n + openQty(l), 0), 'item')}</span>}>
              {rows(o.lines.filter((l) => openQty(l) > 0), openQty)}
              <div className="cfoot"><span className="muted">Nothing can ship until the order is paid.</span></div>
            </Card>
          )}

          {unf.length > 0 && (
            <Card title="Unfulfilled" pill={<span className="pill warn nodot">{plural(unf.reduce((n, l) => n + openQty(l), 0), 'item')}</span>}
              aside={locName(o.locations.find((l) => l.isDefault)?.id ?? null) ? `Ships from ${locName(o.locations.find((l) => l.isDefault)?.id ?? null)}` : undefined}>
              {rows(unf, openQty)}
              <div className="cfoot">
                <span className="muted"><Mail size={13} aria-hidden="true" /> Shipping email goes to {email ?? 'the customer'}</span>
                <span className="sp" />
                {canShipState(o) && !editing && <button type="button" className="btn" onClick={(e) => openDlg('fulfil', e.currentTarget)}><Truck aria-hidden="true" />Fulfil items</button>}
              </div>
            </Card>
          )}

          {pre.length > 0 && (
            <Card title="Pre-order" pill={<span className="pill info nodot">{pre[0]!.shipDateLabel ? `Ships ${pre[0]!.shipDateLabel}` : plural(pre.reduce((n, l) => n + openQty(l), 0), 'item')}</span>}
              aside="Can be fulfilled once stock arrives">
              {rows(pre, openQty)}
            </Card>
          )}

          {nothingLeft && o.fulfillments.length === 0 && removed.length === 0 && (
            <Card title="Fulfilment"><div className="cb-body muted">{doneCopy(o)}</div></Card>
          )}

          {removed.length > 0 && (
            <Card title={cancelled ? 'Cancelled before shipping' : 'Removed'} pill={<span className="pill neu nodot">{cancelled ? 'Not shipped' : 'Refunded before shipping'}</span>}>
              {rows(removed, (l) => l.cancelledQty)}
              {nothingLeft && <div className="cfoot"><span className="muted">{doneCopy(o)}</span></div>}
            </Card>
          )}

          {o.fulfillments.map((f, i) => {
            const n = o.fulfillments.length - i;
            const ls = f.lines.map((fl) => ({ l: o.lines.find((x) => x.id === fl.orderLineId), q: fl.quantity })).filter((x): x is { l: OrderLine; q: number } => !!x.l);
            const items = f.lines.reduce((s, x) => s + x.quantity, 0);
            return (
              <Card key={f.id} title={f.state === 'Delivered' ? 'Delivered' : 'Fulfilled'}
                pill={<span className="pill ok nodot">Parcel {n} · {plural(items, 'item')}</span>}
                aside={[dateTime(f.createdAt), locName(f.locationId)].filter(Boolean).join(' · ')}>
                <table className="ltab"><tbody>{ls.map((x) => row(x.l, x.q))}</tbody></table>
                <div className="cfoot" style={{ flexWrap: 'wrap' }}>
                  <span><Truck size={13} aria-hidden="true" /> {f.trackingCode ? <>{f.carrier ? `${f.carrier} · ` : ''}<span className="mono">{f.trackingCode}</span></> : [f.carrier, 'No tracking'].filter(Boolean).join(' · ')}</span>
                  <span className="sp" />
                  {f.notifyCustomer
                    ? <span className="muted"><CheckCircle2 size={13} aria-hidden="true" /> Shipping email sent</span>
                    : <span className="muted">No shipping email sent</span>}
                  {f === latest && f.state === 'Shipped' && (
                    <button type="button" className="btn sm" disabled={markDelivered.isPending} onClick={() => markDelivered.mutate()}>{markDelivered.isPending ? 'Saving…' : 'Mark delivered'}</button>
                  )}
                </div>
              </Card>
            );
          })}

          <Card title="Payment" pill={<span className={`pill ${pTone}`}>{pLabel}</span>}>
            <div className="cb-body">
              {amountDue != null && amountDue > 0 && <div className="banner w" role="status" style={{ marginBottom: 10 }}><div><b>Balance due.</b> The customer still owes {money(amountDue, cur)} after an edit. Edit the order to send a pay link or record a payment.</div></div>}
              {amountDue != null && amountDue < 0 && <div className="banner i" role="status" style={{ marginBottom: 10 }}><div><b>Credit.</b> {money(-amountDue, cur)} is owed back to the customer. Use Refund to return it.</div></div>}
              <div className="kv"><span className="muted">Subtotal · {plural(o.lines.reduce((n, l) => n + l.quantity, 0), 'item')}</span><span className="num">{money(o.subtotal || sub, cur)}</span></div>
              {o.discountTotal > 0 && <div className="kv"><span className="muted">Discount</span><span className="num">−{money(o.discountTotal, cur)}</span></div>}
              <div className="kv"><span className="muted">{o.shippingMethodName ? `Shipping · ${o.shippingMethodName}` : 'Shipping'}</span><span className="num">{money(o.shippingTotal, cur)}</span></div>
              {o.taxTotal > 0 && <div className="kv"><span className="muted">Tax</span><span className="num">{money(o.taxTotal, cur)}</span></div>}
              {(o.adjustments ?? []).map((a) => <div className="kv" key={a.id}><span className="muted">{a.label}</span><span className="num">{a.amount < 0 ? '−' : '+'}{money(Math.abs(a.amount), cur)}</span></div>)}
              <div className="kv tot"><span>Total</span><span className="num">{money(o.grandTotal, cur)}</span></div>
              {o.payments.length === 0 && <div className="kv"><span className="muted">No payments</span></div>}
              {o.payments.map((p) => (
                <div className="kv" key={p.id}><span className="muted" style={{ textTransform: 'capitalize' }}>{p.state === 'Settled' || p.state === 'captured' ? 'Paid' : p.state} · {p.method}</span><span className="num">{money(p.amount, cur)}</span></div>
              ))}
              {refunded > 0 && <>
                <div className="kv"><span className="muted">Refunded</span><span className="num">−{money(refunded, cur)}</span></div>
                <div className="kv tot"><span>Net payment</span><span className="num">{money(Math.max(0, paid - refunded), cur)}</span></div>
              </>}
              {o.refunds.length > 0 && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgb(var(--border))' }}>
                  <div className="lbl">Refunds</div>
                  {o.refunds.map((r) => (
                    <div key={r.id} style={{ padding: '4px 0' }}>
                      <div className="kv" style={{ padding: 0 }}><span><span className={`pill ${r.state === 'Settled' ? 'ok' : r.state === 'Failed' ? 'bad' : 'warn'}`}>{r.state}</span> {money(r.amount, cur)}</span><span className="muted">{dateTime(r.createdAt)}</span></div>
                      {(r.itemsAmount != null || r.shippingAmount) ? <div className="muted" style={{ fontSize: 12 }}>items {money(r.itemsAmount ?? 0, cur)}{r.shippingAmount ? ` + shipping ${money(r.shippingAmount, cur)}` : ''}</div> : null}
                      {r.creditRestoration?.state === 'posted' && <div className="muted" style={{ fontSize: 12 }}>Cash refunded {money(r.amount, cur)} · credit restored {money(r.creditRestoration.amount, cur)}</div>}
                      {r.creditRestoration?.state === 'reconciliation_required' && <div className="err">Cash refund settled; credit restoration requires reconciliation.</div>}
                      {r.reason && <div className="muted" style={{ fontSize: 12 }}>Reason: {r.reason}</div>}
                      {r.lines.some((l) => l.restock) && <div className="muted" style={{ fontSize: 12 }}>Restock ticked for {plural(r.lines.filter((l) => l.restock).reduce((n, l) => n + l.quantity, 0), 'item')}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card title="Timeline">
            <div className="cb-body">
              <form style={{ display: 'flex', gap: 8, marginBottom: 14 }} onSubmit={(e) => { e.preventDefault(); if (noteText.trim() && !addNote.isPending) addNote.mutate(); }}>
                <input className="inp" placeholder="Add a note for staff (customers never see it)" aria-label="Staff note" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
                <button type="submit" className="btn" disabled={addNote.isPending || !noteText.trim()}>{addNote.isPending ? 'Posting…' : 'Post'}</button>
              </form>
              <div className="tl">
                {o.events.map((e) => (
                  <div key={e.id} className={`ev${e.action === 'note' || e.action === 'fulfill' ? ' k' : ''}`}>
                    {e.action === 'note' ? <><b>Note:</b> {e.data?.note}</>
                      : e.action === 'edit' || e.action === 'edit_address' ? (
                        <><b>{e.action === 'edit' ? 'Order edited' : `${e.data?.kind === 'billing' ? 'Billing' : 'Shipping'} address edited`}</b>{e.data?.reason ? `: ${e.data.reason}` : ''}
                          {e.data?.changes && e.data.changes.length > 0 && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{e.data.changes.join(' · ')}</span>}</>
                      ) : <span>{eventCopy(e, (c) => money(c, o.currency))}</span>}
                    <small>{dateTime(e.at)}{e.actor ? ` · ${e.actor}` : ''}</small>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Customer" aside={o.customer ? 'Linked to this store' : 'Guest'}>
            <div className="cb-body">
              {o.customer ? (
                <Link to={`/customers/${o.customer.id}`} style={{ fontWeight: 500 }} className="lnk">
                  {[o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ') || o.customer.email}
                </Link>
              ) : o.contact?.name ? <span style={{ fontWeight: 500 }}>{o.contact.name}</span> : <span className="muted">Guest checkout</span>}
              {/* #374: a guest order shows the contact captured at checkout. */}
              {(o.customer?.email ?? o.contact?.email) && <div style={{ marginTop: 8 }}>{o.customer?.email ?? o.contact?.email}</div>}
              {(o.customer?.phone ?? o.contact?.phone) && <div className="muted">{o.customer?.phone ?? o.contact?.phone}</div>}
            </div>
          </Card>
          <AddressCard code={o.code} kind="shipping" address={o.shippingAddress} canEdit={canEditAddress} hasCustomer={!!o.customer} onSaved={() => void invalidate()}
            onCountryChange={(form, saveToAddressBook) => { setPendingAddress({ form, saveToAddressBook }); setEditing(true); }} />
          <AddressCard code={o.code} kind="billing" address={o.billingAddress} canEdit={canEditAddress} hasCustomer={!!o.customer} onSaved={() => void invalidate()}
            onCountryChange={() => undefined} />
          {o.attribution && (
            <Card title="Attribution">
              <div className="cb-body">
                {Object.entries(o.attribution).map(([k, v]) => <div className="kv" key={k}><span className="muted">{k}</span><span style={{ wordBreak: 'break-all', textAlign: 'right' }}>{v}</span></div>)}
              </div>
            </Card>
          )}
        </div>
      </div>

      <FulfilDialog code={o.code} open={dlg === 'fulfil'} onClose={closeDlg} />
      <RefundDialog order={o} open={dlg === 'refund'} onClose={closeDlg} returnFocus={trigger} />
      <CancelDialog order={o} open={dlg === 'cancel'} onClose={closeDlg} returnFocus={trigger} />
    </div>
  );
}

function Card({ title, pill, aside, children }: { title: string; pill?: ReactNode; aside?: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="ch">
        <h2>{title}</h2>
        {pill}
        <span className="sp" />
        {aside && <span className="muted" style={{ fontSize: 12 }}>{aside}</span>}
      </div>
      {children}
    </div>
  );
}

interface MenuItem { label: string; icon?: ReactNode; danger?: boolean; run: () => void }

/** Small action menu: opens under its button, arrow keys move, Esc or an outside click closes and refocuses the button. */
function MoreMenu({ btnRef, items }: { btnRef: MutableRefObject<HTMLButtonElement | null>; items: MenuItem[] }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean) => { setPos(null); if (refocus) btnRef.current?.focus(); };

  useEffect(() => {
    if (!pos) return;
    menu.current?.querySelector<HTMLElement>('button')?.focus();
    const onDown = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setPos(null); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pos, btnRef]);

  const onKey = (e: ReactKeyboardEvent) => {
    const btns = [...(menu.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    else if (e.key === 'Tab') setPos(null);
  };

  return (
    <>
      <button type="button" ref={btnRef} className="btn" aria-haspopup="menu" aria-expanded={!!pos}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPos(pos ? null : { top: r.bottom + 4, right: window.innerWidth - r.right }); }}>
        <MoreHorizontal aria-hidden="true" />More actions<ChevronDown aria-hidden="true" />
      </button>
      {pos && (
        <div ref={menu} className="menu" role="menu" style={{ top: pos.top, right: pos.right }} onKeyDown={onKey}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? 'dng' : undefined}
              onClick={() => { setPos(null); it.run(); if (!it.danger) btnRef.current?.focus(); }}>
              {it.icon}{it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
