/**
 * #406 cancel dialog. Unpaid orders use the cancel endpoint. Paid orders cannot be cancelled directly (the
 * server says to refund), so cancelling one refunds everything remaining, with restock capped to shipped
 * units that are not already back in stock.
 */
import { useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { money } from '../lib/format';
import { ModalDialog, DialogError } from './order-dialog';
import { openQty, planRefund, plural, refundable, restockable, shippingLeft, type OrderView } from './order-model';

export function CancelDialog({ order, open, onClose, onDone, returnFocus }: {
  order: OrderView; open: boolean; onClose: () => void; onDone?: () => void; returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <ModalDialog open={open} onClose={onClose} busy={busy} title={`Cancel ${order.code}?`} returnFocus={returnFocus}>
      {() => <CancelForm o={order} busy={busy} setBusy={setBusy} onClose={onClose} onDone={onDone} />}
    </ModalDialog>
  );
}

function CancelForm({ o, busy, setBusy, onClose, onDone }: {
  o: OrderView; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void; onDone?: () => void;
}) {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cur = o.currency;
  const submitting = useRef(false);
  const [key] = useState(() => crypto.randomUUID());
  const [restock, setRestock] = useState(false);
  const [error, setError] = useState('');

  const paid = o.state === 'Paid' || o.state === 'PartiallyRefunded';
  const unshipped = o.lines.reduce((n, l) => n + openQty(l), 0);
  const shipped = o.lines.reduce((n, l) => n + l.fulfilledQty, 0);
  const all = Object.fromEntries(o.lines.map((l) => [l.id, refundable(l)]));
  const everyLine = Object.fromEntries(o.lines.map((l) => [l.id, true]));
  const plan = planRefund(o, all, everyLine);
  const shipLeft = shippingLeft(o);
  const restockN = o.lines.reduce((n, l) => n + restockable(o, l, all[l.id] ?? 0), 0);
  const total = plan.items === null ? null : plan.items + (plan.lines.length ? shipLeft : 0);
  const nothingToRefund = paid && plan.lines.length === 0;
  const canGo = !busy && (!paid || (total !== null && !nothingToRefund));

  const submit = async () => {
    if (submitting.current || !canGo) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      if (paid) {
        const lines = plan.lines.map((l) => ({ ...l, restock: restock && l.restock }));
        await api.post(`/orders/${encodeURIComponent(o.code)}/refund`, {
          idempotencyKey: key, lines, shippingAmount: shipLeft > 0 ? shipLeft : undefined, reason: 'Order cancelled',
        });
        toast.success(`${o.code} cancelled`, `${money(total ?? 0, cur)} refunded.`);
      } else {
        await api.post(`/orders/${encodeURIComponent(o.code)}/cancel`, {});
        toast.success(`${o.code} cancelled`);
      }
      void qc.invalidateQueries({ queryKey: ['order', store?.slug, o.code] });
      void qc.invalidateQueries({ queryKey: ['orders', store?.slug] });
      onDone?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: ['order', store?.slug, o.code] });
    } finally {
      submitting.current = false; setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <div className="db">
        {error && <DialogError title="The order was not cancelled.">{error}</DialogError>}
        {paid ? (
          <>
            <p>
              Cancelling a paid order refunds everything still refundable.
              {total === null
                ? ' Refund pricing for this order needs reconciliation, so it cannot be cancelled here.'
                : nothingToRefund ? ' There is nothing left to refund.' : ''}
            </p>
            {total !== null && !nothingToRefund && (
              <div className="sumbox">
                <div className="kv"><span className="muted">Items ({plural(plan.lines.reduce((n, l) => n + l.quantity, 0), 'unit')})</span><span className="num">{money(plan.items ?? 0, cur)}</span></div>
                <div className="kv"><span className="muted">Shipping</span><span className="num">{money(shipLeft, cur)}</span></div>
                <div className="kv tot"><span>Refund total</span><span className="num">{money(total, cur)}</span></div>
              </div>
            )}
            <p className="muted">
              {unshipped ? `Stops fulfilment of ${plural(unshipped, 'unshipped item')} and releases their stock. ` : ''}
              {shipped ? `${plural(shipped, 'item')} already shipped; parcels are not recalled. ` : ''}
            </p>
            {restockN > 0 && (
              <label className="chk">
                <input type="checkbox" className="cb" checked={restock} disabled={busy} data-autofocus onChange={(e) => setRestock(e.target.checked)} />
                Put {plural(restockN, 'shipped item')} back in stock
              </label>
            )}
          </>
        ) : (
          <p>
            {unshipped ? `Stops fulfilment of ${plural(unshipped, 'unshipped item')} and releases their stock.` : 'Marks the order cancelled.'} No payment has been taken, so there is nothing to refund.
          </p>
        )}
      </div>
      <div className="df">
        <span className="sp" />
        <button type="button" className="btn" onClick={onClose} disabled={busy} data-autofocus={restockN > 0 && paid ? undefined : ''}>Keep order</button>
        <button type="submit" className="btn dngf" disabled={!canGo}>
          {busy ? 'Cancelling…' : paid && total !== null && total > 0 ? `Cancel and refund ${money(total, cur)}` : 'Cancel order'}
        </button>
      </div>
    </form>
  );
}
