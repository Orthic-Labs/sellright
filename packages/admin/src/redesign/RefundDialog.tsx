/**
 * #406 refund dialog. Mirrors the server's limits (refundable units, shipping left, restock only for shipped
 * units); the server still has the last word and its message is shown in the dialog with the inputs kept.
 */
import { useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { money } from '../lib/format';
import { ModalDialog, DialogError } from './order-dialog';
import { isInt, parseMoney, planRefund, plural, refundable, restockable, rsLeft, shippedPart, shippingLeft, type OrderView } from './order-model';

const REASONS = ['Customer changed their mind', 'Damaged in transit', 'Not received', 'Wrong item sent', 'Other'] as const;

interface RefundResult { refundState: string; creditRestoration?: { state: string; amount: number } | null }

export function RefundDialog({ order, open, onClose, onDone, returnFocus }: {
  order: OrderView; open: boolean; onClose: () => void; onDone?: () => void; returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <ModalDialog open={open} onClose={onClose} busy={busy} title={`Refund ${order.code}`} returnFocus={returnFocus}>
      {() => <RefundForm o={order} busy={busy} setBusy={setBusy} onClose={onClose} onDone={onDone} />}
    </ModalDialog>
  );
}

function RefundForm({ o, busy, setBusy, onClose, onDone }: {
  o: OrderView; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void; onDone?: () => void;
}) {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cur = o.currency;
  const submitting = useRef(false);
  // One key per dialog open: a retry of the same submission replays instead of refunding twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [rs, setRs] = useState<Record<string, boolean>>({});
  const [ship, setShip] = useState('0.00');
  const [why, setWhy] = useState<string>(REASONS[0]);
  const [whyOther, setWhyOther] = useState('');
  const [credit, setCredit] = useState(false);
  const [error, setError] = useState('');

  const lines = o.lines.filter((l) => l.quantity > 0 || refundable(l) > 0);
  const checks = lines.map((l) => {
    const raw = (qty[l.id] ?? '').trim() || '0';
    const max = refundable(l);
    const ok = isInt(raw, 0) && Number(raw) <= max;
    return { l, max, ok, q: ok ? Number(raw) : 0 };
  });
  const qtyBad = checks.some((c) => !c.ok);
  const plan = planRefund(o, Object.fromEntries(checks.map((c) => [c.l.id, c.q])), rs);
  const shipLeft = shippingLeft(o);
  const shipCents = parseMoney(ship);
  const shipOk = shipCents !== null && shipCents <= shipLeft;
  const shipAmt = plan.lines.length > 0 && shipCents !== null && shipOk ? shipCents : 0;
  const total = plan.items === null ? null : plan.items + shipAmt;
  const zeroCredit = !!o.hasPostedCredit && plan.lines.length > 0 && total === 0;
  const priceMissing = plan.items === null;
  const canGo = !busy && !qtyBad && shipOk && plan.lines.length > 0 && !priceMissing && total !== null && (total > 0 || (zeroCredit && credit));

  const submit = async () => {
    if (submitting.current || !canGo) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const reason = why === 'Other' ? (whyOther.trim() || 'Other') : why;
      const r = await api.post<RefundResult>(`/orders/${encodeURIComponent(o.code)}/refund`, {
        idempotencyKey: key,
        creditMerchandiseReturn: zeroCredit && credit ? true : undefined,
        lines: plan.lines,
        shippingAmount: shipAmt && shipAmt > 0 ? shipAmt : undefined,
        reason,
      });
      void qc.invalidateQueries({ queryKey: ['order', store?.slug, o.code] });
      void qc.invalidateQueries({ queryKey: ['orders', store?.slug] });
      if (r.refundState === 'Settled') {
        if (r.creditRestoration?.state === 'reconciliation_required') toast.error('Refund settled; credit restoration requires reconciliation');
        else toast.success(`Refunded ${money(total ?? 0, cur)}`, plan.restockUnits ? `${plural(plan.restockUnits, 'item')} back in stock.` : undefined);
      } else if (r.refundState === 'Pending') {
        toast.success('Refund pending confirmation');
      } else {
        // Declined: nothing moved. Fresh key so the next attempt is a new refund, not a replay of the declined one.
        setKey(crypto.randomUUID());
        setError('The payment provider declined this refund. Nothing was refunded.');
        return;
      }
      onDone?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: ['order', store?.slug, o.code] });
    } finally {
      submitting.current = false; setBusy(false);
    }
  };

  const firstOpen = checks.find((c) => c.max > 0)?.l.id;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <div className="db">
        {error && <DialogError title="Nothing was refunded.">{error}</DialogError>}
        <div>
          <div className="lbl">Items</div>
          <div className="fls">
            {checks.map(({ l, max, ok, q }, i) => {
              const sp = shippedPart(l, q), canRs = restockable(o, l, q) > 0, left = rsLeft(o, l);
              return (
                <div key={l.id}>
                  <div className="fl">
                    <div className="fn" style={{ cursor: 'default' }}>
                      <b>{l.name}</b>
                      <span className="muted">
                        {money(l.unitPrice, cur)} each{l.fulfilledQty ? ` · ${l.fulfilledQty} shipped` : ''}{l.refundedQty ? ` · ${l.refundedQty} already refunded` : ''}
                      </span>
                    </div>
                    <label className="rs" title={left === 0 && l.fulfilledQty > 0 ? 'Already back in stock' : sp === 0 ? 'Only shipped items need restocking; unshipped items are released automatically' : undefined}>
                      <input type="checkbox" className="cb" checked={!!rs[l.id] && canRs} disabled={busy || !canRs}
                        onChange={(e) => setRs((m) => ({ ...m, [l.id]: e.target.checked }))} />
                      {l.fulfilledQty > 0 && left === 0 ? 'Restocked' : 'Restock'}
                    </label>
                    <div className="qty">
                      <input className={`inp${ok ? '' : ' bad'}`} type="number" min={0} max={max} step={1} value={qty[l.id] ?? '0'}
                        disabled={busy || max === 0} data-autofocus={l.id === firstOpen ? '' : undefined}
                        aria-label={`Quantity to refund, ${l.name}`} aria-invalid={!ok} aria-describedby={`rqE${i}`}
                        onChange={(e) => setQty((m) => ({ ...m, [l.id]: e.target.value }))} />
                      <span className="muted">of {max}</span>
                    </div>
                  </div>
                  <div className="err" id={`rqE${i}`} style={{ padding: '0 12px 8px 12px' }}>{ok ? '' : `Enter a whole number from 0 to ${max}.`}</div>
                </div>
              );
            })}
          </div>
          <div className="hint" style={{ marginTop: 6 }}>Refunded items that have not shipped come off the order and their stock is released. Shipped items only go back into stock if you tick Restock.</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'start' }}>
          <div className="fld">
            <label htmlFor="rShip">Refund shipping</label>
            <div className="fx">
              <i>$</i>
              <input id="rShip" className={`inp money${shipOk ? '' : ' bad'}`} inputMode="decimal" value={ship} disabled={busy || shipLeft === 0}
                aria-invalid={!shipOk} aria-describedby="rShipH rShipE" onChange={(e) => setShip(e.target.value)} />
            </div>
            <span className="hint" id="rShipH">{shipLeft > 0 ? `Up to ${money(shipLeft, cur)} left` : 'Shipping already refunded or free'}</span>
            <span className="err" id="rShipE">{shipOk ? '' : shipCents === null ? 'Enter an amount like 8.00 (0 or more).' : `Can't be more than ${money(shipLeft, cur)}.`}</span>
          </div>
          <div className="fld">
            <label htmlFor="rWhy">Reason <span style={{ fontWeight: 400 }}>· staff only</span></label>
            <select id="rWhy" className="inp sel" value={why} disabled={busy} onChange={(e) => setWhy(e.target.value)}>
              {REASONS.map((r) => <option key={r}>{r}</option>)}
            </select>
            {why === 'Other' && <input className="inp" style={{ marginTop: 6 }} aria-label="Other reason" value={whyOther} disabled={busy} maxLength={200} onChange={(e) => setWhyOther(e.target.value)} />}
          </div>
        </div>
        <div className="sumbox">
          <div className="kv"><span className="muted">Items</span><span className="num">{plan.items === null ? 'Unavailable' : money(plan.items, cur)}</span></div>
          <div className="kv"><span className="muted">Shipping</span><span className="num">{money(shipAmt ?? 0, cur)}</span></div>
          <div className="kv"><span className="muted">Back in stock</span><span className="num">{plural(plan.restockUnits, 'item')}</span></div>
          <div className="kv tot"><span>Refund total</span><span className="num">{total === null ? 'Unavailable' : money(total, cur)}</span></div>
          <div className="err" role="alert">{priceMissing && plan.lines.length > 0 ? 'Refund pricing for these items needs reconciliation.' : ''}</div>
        </div>
        {zeroCredit && (
          <label className="chk">
            <input type="checkbox" className="cb" checked={credit} disabled={busy} onChange={(e) => setCredit(e.target.checked)} />
            Return credit merchandise: cash refund {money(0, cur)}; restore the original allocated credit.
          </label>
        )}
        <div className="note"><CreditCard size={14} aria-hidden="true" /><span>Goes back to the original payment{o.payments[0] ? ` (${o.payments[0].method})` : ''}.</span></div>
      </div>
      <div className="df">
        <span className="sp" />
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn pri" disabled={!canGo}>{busy ? 'Refunding…' : total && total > 0 ? `Refund ${money(total, cur)}` : 'Refund'}</button>
      </div>
    </form>
  );
}
