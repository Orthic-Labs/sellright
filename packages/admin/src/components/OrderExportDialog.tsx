import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, downloadFile } from '../api';
import { useAuth } from '../auth';
import { useToast } from './Toast';
import { Modal, Field, InlineAlert, Spinner } from './ui';
import { FULFILLMENT_OPTIONS, ORDER_OPTIONS, PAYMENT_OPTIONS, type OrderFilters } from '../lib/order-status';
import { RANGE_LABELS, loadPresets, rangeFor, savePresets, upsertPreset, type ExportPreset, type RangePreset } from '../lib/export-presets';

interface Catalog { columns: { key: string; label: string; group: string; lineOnly: boolean }[]; defaults: string[]; lineDefaults: string[]; cap: number }

const PAYMENT_METHODS = [{ value: 'nmi', label: 'Card (NMI)' }, { value: 'sezzle', label: 'Sezzle' }, { value: 'stripe', label: 'Stripe' }, { value: 'manual', label: 'Manual / phone' }];

/** Export dialog: starts from the list's current filters; every choice maps 1:1 onto the export endpoint's query. */
export default function OrderExportDialog({ open, onClose, filters }: { open: boolean; onClose: () => void; filters: OrderFilters }) {
  const { store } = useAuth();
  const toast = useToast();
  const shipMethods = useQuery({ queryKey: ['shipping', store?.slug], queryFn: () => api.get<{ items: Array<{ code: string; name: string }> }>('/shipping-methods'), enabled: open, staleTime: 5 * 60_000 });
  const cat = useQuery({ queryKey: ['export-columns', store?.slug], queryFn: () => api.get<Catalog>('/export/orders/columns'), enabled: open, staleTime: 5 * 60_000 });

  const [range, setRange] = useState<RangePreset>('last365');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [payment, setPayment] = useState(''); const [fulfillment, setFulfillment] = useState(''); const [orderStatus, setOrderStatus] = useState('');
  const [preOrder, setPreOrder] = useState(false);
  const [shipMethod, setShipMethod] = useState('');
  const [method, setMethod] = useState(''); const [country, setCountry] = useState(''); const [coupon, setCoupon] = useState(''); const [q, setQ] = useState('');
  const [rows, setRows] = useState<'order' | 'line'>('order');
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [cols, setCols] = useState<string[] | null>(null);
  const [presets, setPresets] = useState<ExportPreset[]>(() => loadPresets());
  const [presetName, setPresetName] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-seed from the list's current filters every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const hasRange = !!(filters.from || filters.to);
    setRange(hasRange ? 'custom' : 'last365'); setFrom(filters.from); setTo(filters.to);
    setPayment(filters.paymentStatus); setFulfillment(filters.fulfillmentStatus); setOrderStatus(filters.status);
    setPreOrder(filters.preOrder); setQ(filters.q);
    setShipMethod(''); setMethod(''); setCountry(''); setCoupon(''); setRows('order'); setFormat('csv'); setPresetName(''); setPresets(loadPresets());
  }, [open, filters]);
  useEffect(() => { if (cat.data && cols === null) setCols(cat.data.defaults); }, [cat.data, cols]);

  const selected = cols ?? [];
  const lineKeys = useMemo(() => new Set(cat.data?.columns.filter((c) => c.lineOnly).map((c) => c.key)), [cat.data]);
  const groups = useMemo(() => {
    const g = new Map<string, Catalog['columns']>();
    for (const c of cat.data?.columns ?? []) g.set(c.group, [...(g.get(c.group) ?? []), c]);
    return [...g.entries()];
  }, [cat.data]);

  const setRangePreset = (r: RangePreset) => { setRange(r); if (r !== 'custom') { const x = rangeFor(r); setFrom(x.from); setTo(x.to); } };
  const toggleCol = (k: string) => setCols((cur) => { const c = cur ?? []; return c.includes(k) ? c.filter((x) => x !== k) : [...c, k]; });
  const changeRows = (r: 'order' | 'line') => {
    setRows(r);
    if (r === 'line' && cat.data && !selected.some((k) => lineKeys.has(k))) setCols([...selected, ...cat.data.lineDefaults]);
  };

  function applyPreset(p: ExportPreset) { setRows(p.rows); setCols(p.columns); }
  function savePreset() {
    const name = presetName.trim();
    if (!name) return;
    const next = upsertPreset(presets, { name, columns: selected, rows });
    setPresets(next); savePresets(next); setPresetName(''); toast.success(`Preset "${name}" saved`);
  }
  function deletePreset(name: string) { const next = presets.filter((p) => p.name !== name); setPresets(next); savePresets(next); }

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (range === 'all') p.set('days', '3650');
    else { if (from) p.set('from', from); if (to) p.set('to', to); if (!from && !to) p.set('days', '365'); }
    if (payment) p.set('paymentStatus', payment);
    if (fulfillment) p.set('fulfillmentStatus', fulfillment);
    if (orderStatus === 'archived') p.set('trashed', '1'); else if (orderStatus) p.set('status', orderStatus);
    if (preOrder) p.set('preOrder', '1');
    if (method) p.set('paymentMethod', method);
    if (shipMethod) p.set('shippingMethod', shipMethod);
    if (country.trim()) p.set('country', country.trim());
    if (coupon.trim()) p.set('coupon', coupon.trim());
    if (q.trim()) p.set('q', q.trim());
    p.set('rows', rows);
    if (selected.length) p.set('columns', selected.join(','));
    return p;
  }, [range, from, to, payment, fulfillment, orderStatus, preOrder, method, shipMethod, country, coupon, q, rows, selected]);

  const rangeInvalid = range === 'custom' && !!from && !!to && from > to;
  const noColumns = selected.filter((k) => rows === 'line' || !lineKeys.has(k)).length === 0;

  async function run() {
    setBusy(true);
    try {
      const ext = format === 'xlsx' ? 'orders.xlsx' : 'orders';
      await downloadFile(`/export/${ext}?${query}`, `orders-${store?.slug ?? 'store'}${rows === 'line' ? '-lines' : ''}.${format}`);
      toast.success('Export started'); onClose();
    } catch (e) { toast.error('Export failed', (e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Export orders" width="max-w-3xl">
      <div className="space-y-5">
        <p className="text-xs text-gray-500">Starts from your current order filters. Change anything below; the file contains up to {(cat.data?.cap ?? 50000).toLocaleString()} {rows === 'line' ? 'line items' : 'orders'}.</p>

        <section className="grid sm:grid-cols-2 gap-3" aria-label="Which orders">
          <Field label="Date range" htmlFor="ex-range">
            <select id="ex-range" className="input" value={range} onChange={(e) => setRangePreset(e.target.value as RangePreset)}>
              {(Object.keys(RANGE_LABELS) as RangePreset[]).map((k) => <option key={k} value={k}>{RANGE_LABELS[k]}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From" htmlFor="ex-from"><input id="ex-from" type="date" className="input" value={from} disabled={range === 'all'} onChange={(e) => { setRange('custom'); setFrom(e.target.value); }} /></Field>
            <Field label="To (included)" htmlFor="ex-to"><input id="ex-to" type="date" className="input" value={to} disabled={range === 'all'} onChange={(e) => { setRange('custom'); setTo(e.target.value); }} /></Field>
          </div>
          <Field label="Payment status" htmlFor="ex-pay"><Select id="ex-pay" value={payment} onChange={setPayment} options={PAYMENT_OPTIONS} any="Any payment status" /></Field>
          <Field label="Fulfillment status" htmlFor="ex-ful"><Select id="ex-ful" value={fulfillment} onChange={setFulfillment} options={FULFILLMENT_OPTIONS} any="Any fulfillment status" /></Field>
          <Field label="Order" htmlFor="ex-ord"><Select id="ex-ord" value={orderStatus} onChange={setOrderStatus} options={ORDER_OPTIONS} any="Any (open and cancelled)" /></Field>
          <Field label="Pre-orders" htmlFor="ex-pre">
            <select id="ex-pre" className="input" value={preOrder ? '1' : ''} onChange={(e) => setPreOrder(e.target.value === '1')}><option value="">All orders</option><option value="1">Pre-orders only</option></select>
          </Field>
          <Field label="Payment method" htmlFor="ex-method"><Select id="ex-method" value={method} onChange={setMethod} options={PAYMENT_METHODS} any="Any payment method" /></Field>
          <Field label="Shipping method" htmlFor="ex-ship"><Select id="ex-ship" value={shipMethod} onChange={setShipMethod} options={[...(shipMethods.data?.items ?? []).map((m) => ({ value: m.code, label: m.name })), { value: '__none__', label: 'No recorded method' }]} any="Any shipping method" /></Field>
          <Field label="Ship-to country" htmlFor="ex-country" hint="2-letter code, e.g. US."><input id="ex-country" className="input uppercase" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Any" /></Field>
          <Field label="Coupon code" htmlFor="ex-coupon"><input id="ex-coupon" className="input" value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="Any" /></Field>
          <Field label="Search" htmlFor="ex-q" hint="Order code or customer email."><input id="ex-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Any" /></Field>
        </section>
        {rangeInvalid && <InlineAlert tone="critical">The start date is after the end date.</InlineAlert>}

        <section className="border-t border-gray-100 pt-4 space-y-3" aria-label="Rows and columns">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <fieldset className="flex items-center gap-3"><legend className="sr-only">Rows</legend>
              <span className="text-gray-500">One row per</span>
              <label className="inline-flex items-center gap-1.5"><input type="radio" name="ex-rows" className="accent-brand" checked={rows === 'order'} onChange={() => changeRows('order')} /> order</label>
              <label className="inline-flex items-center gap-1.5"><input type="radio" name="ex-rows" className="accent-brand" checked={rows === 'line'} onChange={() => changeRows('line')} /> line item</label>
            </fieldset>
            <fieldset className="flex items-center gap-3"><legend className="sr-only">Format</legend>
              <span className="text-gray-500">Format</span>
              <label className="inline-flex items-center gap-1.5"><input type="radio" name="ex-fmt" className="accent-brand" checked={format === 'csv'} onChange={() => setFormat('csv')} /> CSV</label>
              <label className="inline-flex items-center gap-1.5"><input type="radio" name="ex-fmt" className="accent-brand" checked={format === 'xlsx'} onChange={() => setFormat('xlsx')} /> XLSX</label>
            </fieldset>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-500">Presets</span>
            <button className="btn-ghost btn-sm" onClick={() => cat.data && (setRows('order'), setCols(cat.data.defaults))}>Default</button>
            {presets.map((p) => (
              <span key={p.name} className="inline-flex items-center rounded-md border border-gray-300 bg-surface">
                <button className="px-2 py-1" onClick={() => applyPreset(p)}>{p.name}</button>
                <button aria-label={`Delete preset ${p.name}`} className="px-1.5 py-1 text-gray-400 hover:text-danger" onClick={() => deletePreset(p.name)}>×</button>
              </span>
            ))}
            <span className="ml-auto inline-flex items-center gap-1.5">
              <input className="input !py-1 !text-xs w-36" aria-label="Preset name" placeholder="Save columns as…" value={presetName} onChange={(e) => setPresetName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') savePreset(); }} />
              <button className="btn-ghost btn-sm" disabled={!presetName.trim() || selected.length === 0} onClick={savePreset}>Save</button>
            </span>
          </div>

          {cat.isLoading ? <div className="text-sm text-gray-400 flex items-center gap-2"><Spinner /> Loading columns…</div> : cat.error ? <InlineAlert tone="critical">{(cat.error as Error).message}</InlineAlert> : (
            <div className="grid sm:grid-cols-3 gap-x-4 gap-y-3">
              {groups.map(([g, list]) => (
                <fieldset key={g} className="min-w-0">
                  <legend className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">{g}</legend>
                  {list.map((c) => {
                    const disabled = c.lineOnly && rows !== 'line';
                    return (
                      <label key={c.key} className={`flex items-center gap-2 py-0.5 text-sm ${disabled ? 'text-gray-300' : ''}`} title={disabled ? 'Only for one row per line item' : undefined}>
                        <input type="checkbox" className="h-4 w-4 accent-brand" disabled={disabled} checked={!disabled && selected.includes(c.key)} onChange={() => toggleCol(c.key)} />
                        <span className="truncate">{c.label}</span>
                      </label>
                    );
                  })}
                </fieldset>
              ))}
            </div>
          )}
        </section>

        <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
          <span className="text-xs text-gray-400">Columns appear in the order you ticked them.</span>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy || rangeInvalid || noColumns || cat.isLoading} onClick={run}>{busy ? <Spinner className="text-white" /> : `Download ${format.toUpperCase()}`}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Select({ id, value, onChange, options, any }: { id: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; any: string }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{any}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
