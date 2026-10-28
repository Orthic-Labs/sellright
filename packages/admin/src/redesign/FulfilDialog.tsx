/**
 * #406 fulfil dialog, shared by the orders list (quick view + bulk) and the order page.
 * Always notifies the customer (the API default and the signed-off design: no toggle).
 */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Truck } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { addressLines } from '../components/order-edit/AddressCard';
import { ModalDialog, DialogError } from './order-dialog';
import { CARRIERS, canShipState, detectCarrier, isInt, isPre, openQty, plural, trackErr, type OrderLine, type OrderView } from './order-model';

export interface FulfilDialogProps {
  /** Order code to fulfil. */
  code: string;
  open: boolean;
  onClose: () => void;
  /** Called after the API committed the shipment. */
  onDone?: (r: { fulfillmentId: string }) => void;
}

interface LocationRow { id: string; name: string; isDefault?: boolean; enabled?: boolean }
type Pick = { checked: boolean; qty: string };

export function FulfilDialog({ code, open, onClose, onDone }: FulfilDialogProps) {
  const [busy, setBusy] = useState(false);
  const order = useOrder(code, open);
  return (
    <ModalDialog open={open} onClose={onClose} busy={busy} title={`Fulfil ${code}`}
      subtitle={order.data ? [order.data.customer?.firstName, order.data.customer?.lastName].filter(Boolean).join(' ') : undefined}>
      {(titleId) => order.data
        ? <FulfilForm key={code} o={order.data} titleId={titleId} busy={busy} setBusy={setBusy} onClose={onClose} onDone={onDone} />
        : (
          <>
            <div className="db" role="status" aria-live="polite">
              {order.error ? <DialogError title="Couldn't load this order.">{(order.error as Error).message}</DialogError> : <span className="muted">Loading order…</span>}
            </div>
            <div className="df"><span className="sp" />{order.error && <button type="button" className="btn" onClick={() => void order.refetch()}>Retry</button>}<button type="button" className="btn" onClick={onClose}>Close</button></div>
          </>
        )}
    </ModalDialog>
  );
}

function useOrder(code: string, enabled: boolean) {
  const { store } = useAuth();
  return useQuery({
    queryKey: ['order', store?.slug, code],
    queryFn: () => api.get<OrderView>(`/orders/${encodeURIComponent(code)}`),
    enabled,
  });
}

function FulfilForm({ o, busy, setBusy, onClose, onDone }: {
  o: OrderView; titleId: string; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void; onDone?: FulfilDialogProps['onDone'];
}) {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const submitting = useRef(false);

  const locs = useQuery({ queryKey: ['locations', store?.slug], queryFn: () => api.get<{ items: LocationRow[] }>('/locations') });
  const locations = (locs.data?.items ?? []).filter((l) => l.enabled !== false);

  const lines = o.lines.filter((l) => openQty(l) > 0);
  const shippable = lines.filter((l) => !isPre(l));
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState<string>(() => (/usps/i.test(o.shippingMethodName ?? '') ? 'USPS' : ''));
  const [locationId, setLocationId] = useState('');
  const [error, setError] = useState('');

  const pick = (l: OrderLine): Pick => picks[l.id] ?? { checked: true, qty: String(openQty(l)) };
  const setPick = (l: OrderLine, p: Partial<Pick>) => setPicks((m) => ({ ...m, [l.id]: { ...pick(l), ...p } }));

  const loc = locationId || locations.find((l) => l.isDefault)?.id || locations[0]?.id || '';
  const email = o.customer?.email;
  const trkErr = trackErr(tracking);
  const rows = shippable.map((l) => {
    const p = pick(l), max = openQty(l);
    const ok = !p.checked || (isInt(p.qty, 1) && Number(p.qty) <= max);
    return { l, p, max, ok };
  });
  const chosen = rows.filter((r) => r.p.checked && r.ok);
  const units = chosen.reduce((n, r) => n + Number(r.p.qty), 0);
  const bad = rows.some((r) => !r.ok);
  const canGo = !busy && units > 0 && !bad && !trkErr && canShipState(o);

  const onTracking = (v: string) => {
    setTracking(v);
    const c = detectCarrier(v);
    if (c) setCarrier(c);
  };

  const submit = async () => {
    if (submitting.current || !canGo) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const raw = tracking.trim();
      const hasTracking = !!raw.replace(/[\s-]/g, '');
      const r = await api.post<{ fulfillmentId: string }>(`/orders/${encodeURIComponent(o.code)}/fulfillments`, {
        lines: chosen.map((x) => ({ orderLineId: x.l.id, quantity: Number(x.p.qty) })),
        locationId: loc || undefined,
        trackingCode: hasTracking ? raw : undefined,
        carrier: carrier || undefined,
        notifyCustomer: true,
      });
      void qc.invalidateQueries({ queryKey: ['order', store?.slug, o.code] });
      void qc.invalidateQueries({ queryKey: ['orders', store?.slug] });
      toast.success(`Fulfilled ${plural(units, 'item')} on ${o.code}`, 'Shipping email sent.');
      onDone?.({ fulfillmentId: r.fulfillmentId });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: ['order', store?.slug, o.code] });
    } finally {
      submitting.current = false; setBusy(false);
    }
  };

  if (!canShipState(o) || !shippable.length) {
    return (
      <>
        <div className="db"><p>{!canShipState(o) ? `This order is ${o.state}, so nothing can ship right now.` : 'Nothing on this order can ship right now.'}</p></div>
        <div className="df"><span className="sp" /><button type="button" className="btn" onClick={onClose}>Close</button></div>
      </>
    );
  }

  const shipTo = addressLines(o.shippingAddress)[2];
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <div className="db">
        {error && <DialogError title="Nothing was shipped.">{error}</DialogError>}
        <div>
          <div className="lbl">Items in this parcel</div>
          <div className="fls">
            {lines.map((l, i) => {
              if (isPre(l)) {
                return (
                  <div className="fl dis" key={l.id}>
                    <input type="checkbox" className="cb" disabled aria-label={`${l.name}, pre-order, not in stock`} />
                    <div className="fn"><b>{l.name}</b><span className="muted"><span className="mono">{l.sku}</span></span></div>
                    <span className="pill info">Pre-order{l.shipDateLabel ? ` · ships ${l.shipDateLabel}` : ''}</span>
                  </div>
                );
              }
              const p = pick(l), max = openQty(l), ok = rows.find((r) => r.l.id === l.id)!.ok;
              return (
                <div key={l.id}>
                  <div className="fl">
                    <input type="checkbox" className="cb" id={`fl${i}`} checked={p.checked} disabled={busy} data-autofocus={i === 0 ? '' : undefined}
                      onChange={(e) => setPick(l, { checked: e.target.checked })} />
                    <label className="fn" htmlFor={`fl${i}`}>
                      <b>{l.name}</b>
                      <span className="muted"><span className="mono">{l.sku}</span>{l.fulfilledQty > 0 ? ` · ${l.fulfilledQty} already shipped` : ''}</span>
                    </label>
                    <div className="qty">
                      <input className={`inp${ok ? '' : ' bad'}`} type="number" min={1} max={max} step={1} value={p.qty}
                        disabled={busy || !p.checked} aria-label={`Quantity to ship, ${l.name}`} aria-invalid={!ok} aria-describedby={`fqE${i}`}
                        onChange={(e) => setPick(l, { qty: e.target.value })} />
                      <span className="muted">of {max}</span>
                    </div>
                  </div>
                  <div className="err" id={`fqE${i}`} style={{ padding: '0 12px 8px 39px' }}>{ok ? '' : `Enter a whole number from 1 to ${max}.`}</div>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {locations.length > 0 && (
            <div className="fld">
              <label htmlFor="fLoc">Ship from</label>
              <select id="fLoc" className="inp sel" value={loc} disabled={busy} onChange={(e) => setLocationId(e.target.value)}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          <div className="fld">
            <span className="fl-l">Ship to</span>
            <div style={{ minHeight: 30, display: 'flex', alignItems: 'center' }} className="muted">{[shipTo, o.shippingMethodName].filter(Boolean).join(' · ') || 'Address on the order'}</div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 10, alignItems: 'start' }}>
          <div className="fld">
            <label htmlFor="fTrk">Tracking number <span style={{ fontWeight: 400 }}>· optional</span></label>
            <input id="fTrk" className={`inp mono${trkErr ? ' bad' : ''}`} autoComplete="off" value={tracking} disabled={busy}
              aria-invalid={!!trkErr} aria-describedby="fTrkErr" onChange={(e) => onTracking(e.target.value)} />
            <span className="err" id="fTrkErr">{trkErr}</span>
          </div>
          <div className="fld">
            <label htmlFor="fCar">Carrier</label>
            <select id="fCar" className="inp sel" value={carrier} disabled={busy} onChange={(e) => setCarrier(e.target.value)}>
              <option value="">Not set</option>
              {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="note">
          <Mail size={14} aria-hidden="true" />
          <span>Sends the shipping email to <b>{email ?? 'the customer'}</b>{o.fulfillments.length ? ` (parcel ${o.fulfillments.length + 1})` : ''}.</span>
        </div>
      </div>
      <div className="df">
        <span className="err" role="status">{units || bad ? '' : 'Select at least one item.'}</span>
        <span className="sp" />
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn pri" disabled={!canGo}>
          <Truck aria-hidden="true" />{busy ? 'Fulfilling…' : `Fulfil ${plural(units, 'item')}`}
        </button>
      </div>
    </form>
  );
}
