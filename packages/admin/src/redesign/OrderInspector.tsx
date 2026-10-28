/** #406 orders list quick view (360px). Bound to the selected row; fetches the full order for items and activity. */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Truck, X, Check } from 'lucide-react';
import { api, type OrderDetail, type OrderRow } from '../api';
import { useAuth } from '../auth';
import { money, dateTime } from '../lib/format';
import { addressLines } from '../components/order-edit/AddressCard';
import { LoadError, LoadingRows } from './states';
import { fulfilmentPill, paymentPill, shippableQty } from './orders-helpers';
import { PillView } from './orders-ui';

type Line = OrderDetail['lines'][number];

function lineState(l: Line): string | null {
  const removed = Math.max(l.refundedQty, l.cancelledQty);
  if (l.fulfilledQty > 0 && l.fulfilledQty >= l.quantity - removed) return 'Shipped';
  if (l.fulfilledQty > 0) return `${l.fulfilledQty} of ${l.quantity} shipped`;
  if (removed >= l.quantity) return 'Removed';
  if (removed > 0) return `${removed} removed`;
  return null;
}

function eventLabel(e: OrderDetail['events'][number]): string {
  if (e.action === 'note') return `Note: ${e.data?.note ?? ''}`;
  if (e.action === 'edit') return 'Order edited';
  if (e.action === 'edit_address') return 'Address edited';
  const a = e.action.replace(/_/g, ' ');
  return `${a.charAt(0).toUpperCase()}${a.slice(1)}${e.toState ? ` → ${e.toState}` : ''}`;
}

export default function OrderInspector({ row, onClose, onFulfil }: { row: OrderRow; onClose: () => void; onFulfil: (code: string) => void }) {
  const { store } = useAuth();
  const q = useQuery({
    queryKey: ['order', store?.slug, row.code],
    queryFn: () => api.get<OrderDetail>(`/orders/${encodeURIComponent(row.code)}`),
  });
  const o = q.data;
  const fp = fulfilmentPill(row);
  const email = o?.customer?.email ?? row.email;
  const name = o?.customer ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ') : [row.firstName, row.lastName].filter(Boolean).join(' ');
  const canShip = shippableQty(row) > 0 && fp.label !== 'Cancelled';
  const preOnly = !canShip && (row.openPreOrderQty ?? 0) > 0 && fp.label !== 'Cancelled';
  const events = o ? [...o.events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5) : [];
  const addr = o ? addressLines(o.shippingAddress).filter((l) => l !== o.shippingAddress?.phone) : [];

  return (
    <aside className="insp" aria-label="Order quick view">
      <div className="sec ih">
        <Link to={`/orders/${encodeURIComponent(row.code)}`} className="lnk mono" style={{ fontSize: 14 }}>{row.code}</Link>
        <PillView pill={paymentPill(row.paymentStatus)} />
        <PillView pill={fp} />
        <span className="sp" />
        <Link to={`/orders/${encodeURIComponent(row.code)}`} className="iconbtn" aria-label={`Open ${row.code}`}><ExternalLink size={15} aria-hidden="true" /></Link>
        <button className="iconbtn" aria-label="Close quick view" onClick={onClose}><X size={15} aria-hidden="true" /></button>
      </div>

      <div className="sec"><div className="lbl">Customer</div>
        {name && <div style={{ fontWeight: 500 }}>{name}</div>}
        <div className={name ? 'muted' : ''}>{email ?? '—'}</div>
      </div>

      {q.isLoading && <div className="sec"><LoadingRows label="Loading order" rows={4} cols={[60, 0]} /></div>}
      {q.error && <div className="sec"><LoadError what="this order" detail={(q.error as Error).message} onRetry={() => q.refetch()} /></div>}

      {o && (
        <>
          <div className="sec"><div className="lbl">Ship to</div>
            {addr.length ? addr.map((l, i) => <div key={i}>{l}</div>) : <div className="muted">No shipping address</div>}
            {o.shippingMethodName && <div className="muted">{o.shippingMethodName}</div>}
          </div>
          <div className="sec"><div className="lbl">Items</div>
            {o.lines.map((l) => {
              const st = lineState(l);
              return (
                <div className="kv" key={l.id}>
                  <div>{l.name} <span className="muted">· <span className="mono">{l.sku}</span> × {l.quantity}</span>{st && <div className="hint">{st}</div>}</div>
                  <span className="num">{money(l.lineTotal, o.currency)}</span>
                </div>
              );
            })}
            {o.discountTotal > 0 && <div className="kv muted"><span>Discount</span><span className="num">−{money(o.discountTotal, o.currency)}</span></div>}
            <div className="kv muted"><span>Shipping</span><span className="num">{money(o.shippingTotal, o.currency)}</span></div>
            {o.taxTotal > 0 && <div className="kv muted"><span>Tax</span><span className="num">{money(o.taxTotal, o.currency)}</span></div>}
            <div className="kv tot"><span>Total</span><span className="num">{money(o.grandTotal, o.currency)}</span></div>
          </div>
        </>
      )}

      <div className="sec">
        {fp.label === 'Cancelled' ? <div className="muted">Cancelled. Nothing left to ship.</div>
          : canShip ? (
            <>
              <button className="btn pri" style={{ width: '100%' }} onClick={() => onFulfil(row.code)}><Truck size={14} aria-hidden="true" />Fulfil items…</button>
              <div className="hint" style={{ marginTop: 6 }}>Sends the shipping email to {email ?? 'the customer'}.</div>
            </>
          ) : preOnly ? (
            <>
              <button className="btn" style={{ width: '100%' }} disabled><Truck size={14} aria-hidden="true" />Waiting on pre-order stock</button>
              <div className="hint" style={{ marginTop: 6 }}>Ships {row.openPreOrderQty} once stock arrives.</div>
            </>
          ) : fp.label === 'Nothing to ship' ? <div className="muted">Nothing to ship.</div>
            : <div className="muted"><Check size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> All items have shipped.</div>}
      </div>

      {o && events.length > 0 && (
        <div className="sec" style={{ border: 0 }}><div className="lbl">Activity</div>
          <div className="tl">
            {events.map((e) => <div className="ev" key={e.id}>{eventLabel(e)}<small>{dateTime(e.at)}{e.actor ? ` · ${e.actor}` : ''}</small></div>)}
          </div>
        </div>
      )}
    </aside>
  );
}
