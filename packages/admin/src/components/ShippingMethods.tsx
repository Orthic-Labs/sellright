import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, X } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, FormSection, Field, InlineAlert, Spinner } from './ui';
import { useConfirmDialog } from './ConfirmDialog';
import {
  buildMethodPayload, emptyForm, formFromMethod, parseCountries, summarizeCalculator, validateForm,
  type CountryMode, type MethodForm,
} from '../lib/shipping-method';

interface Method { id: string; code: string; name: string; enabled: boolean; calculator: unknown }

/** Settings > Shipping: list with plain-language summaries + an edit drawer covering every calculator field. */
export default function ShippingMethods({ canManage }: { canManage: boolean }) {
  const { store } = useAuth();
  const cur = store?.currency ?? 'USD';
  const { confirm, dialog } = useConfirmDialog();
  const ship = useQuery({ queryKey: ['shipping', store?.slug], queryFn: () => api.get<{ items: Method[] }>('/shipping-methods') });
  const [editing, setEditing] = useState<{ id: string | null; existing?: Method } | null>(null);
  const del = useMutation({ mutationFn: (id: string) => api.del(`/shipping-methods/${id}`), onSuccess: () => ship.refetch() });
  const toggle = useMutation({
    mutationFn: (m: Method) => api.patch(`/shipping-methods/${m.id}`, { enabled: !m.enabled }),
    onSuccess: () => ship.refetch(),
  });

  return (
    <>
      {dialog}
      <FormSection title="Shipping methods" description="At checkout a customer is offered every enabled method whose conditions match their cart and destination."
        actions={canManage && <button className="btn-ghost btn-sm" onClick={() => setEditing({ id: null })}><Plus size={14} /> Add method</button>}>
        <div className="divide-y divide-gray-100">
          {ship.data?.items.map((m) => (
            <div key={m.id} className="py-3 text-sm flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{m.name} <span className="text-gray-400 text-xs font-normal">{m.code}</span></div>
                <div className="text-xs text-gray-500 mt-0.5">{summarizeCalculator(m.calculator, cur)}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge value={m.enabled ? 'active' : 'draft'} label={m.enabled ? 'Enabled' : 'Disabled'} />
                {canManage && (
                  <>
                    <button className="btn-ghost btn-sm" onClick={() => setEditing({ id: m.id, existing: m })}><Pencil size={13} /> Edit</button>
                    <button className="p-2 text-gray-400 hover:text-danger" aria-label={`Delete ${m.name}`} onClick={async () => {
                      if (await confirm({ title: `Delete "${m.name}"?`, description: 'Customers will no longer be offered this method. Existing orders are not changed.', tone: 'danger', confirmLabel: 'Delete method' })) del.mutate(m.id);
                    }}><Trash2 size={15} /></button>
                  </>
                )}
              </div>
            </div>
          ))}
          {ship.data?.items.length === 0 && <div className="text-sm text-gray-400 py-2">No shipping methods yet.</div>}
        </div>
        {!canManage && <InlineAlert tone="neutral">Only owners and managers can change shipping methods.</InlineAlert>}
        {toggle.error && <InlineAlert tone="critical">{(toggle.error as Error).message}</InlineAlert>}
      </FormSection>
      {editing && <MethodDrawer key={editing.id ?? 'new'} currency={cur} editing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void ship.refetch(); }} />}
    </>
  );
}

function MethodDrawer({ currency, editing, onClose, onSaved }: {
  currency: string; editing: { id: string | null; existing?: Method }; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState<MethodForm>(() => (editing.existing ? formFromMethod(editing.existing) : emptyForm()));
  const set = <K extends keyof MethodForm>(k: K, v: MethodForm[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const errors = validateForm(f);
  const payload = buildMethodPayload(f, editing.existing?.calculator);
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => { firstField.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: () => (editing.id
      ? api.patch(`/shipping-methods/${editing.id}`, payload)
      : api.post('/shipping-methods', payload)),
    onSuccess: onSaved,
  });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 animate-fade-in" onClick={onClose} aria-hidden="true" />
      <aside className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-surface border-l border-line shadow-lg flex flex-col" role="dialog" aria-modal="true" aria-label={editing.id ? 'Edit shipping method' : 'Add shipping method'}>
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold">{editing.id ? `Edit ${editing.existing?.name ?? 'method'}` : 'Add shipping method'}</h2>
          <button aria-label="Close" className="p-1 text-gray-400 hover:text-ink" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" htmlFor="sm-name"><input id="sm-name" ref={firstField} className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Code" htmlFor="sm-code" hint="Used by the storefront."><input id="sm-code" className="input font-mono text-xs" value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Offer this method at checkout</label>

          <fieldset className="space-y-3 border-t border-gray-100 pt-4">
            <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 pb-1">Rate and order size</legend>
            <Field label={`Shipping rate (${currency})`} htmlFor="sm-rate" hint="0 = free shipping."><input id="sm-rate" className="input tnum w-32" inputMode="decimal" value={f.rate} onChange={(e) => set('rate', e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Minimum subtotal" htmlFor="sm-min" hint="Blank = no minimum. Included."><input id="sm-min" className="input tnum" inputMode="decimal" placeholder="none" value={f.min} onChange={(e) => set('min', e.target.value)} /></Field>
              <Field label="Maximum subtotal" htmlFor="sm-max" hint="Blank = no maximum. Included."><input id="sm-max" className="input tnum" inputMode="decimal" placeholder="none" value={f.max} onChange={(e) => set('max', e.target.value)} /></Field>
            </div>
            <Field label="Subtotal used for the minimum and maximum" htmlFor="sm-basis">
              <select id="sm-basis" className="input" value={f.basis} onChange={(e) => set('basis', e.target.value as MethodForm['basis'])}>
                <option value="pre_discount">Before discounts</option>
                <option value="discounted_with_tax">After discounts, including tax</option>
              </select>
            </Field>
          </fieldset>

          <fieldset className="space-y-3 border-t border-gray-100 pt-4">
            <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 pb-1">Destinations</legend>
            <Field label="Ship to" htmlFor="sm-cmode">
              <select id="sm-cmode" className="input" value={f.countryMode} onChange={(e) => set('countryMode', e.target.value as CountryMode)}>
                <option value="all">All countries</option>
                <option value="only">Only these countries</option>
                <option value="except">All countries except these</option>
              </select>
            </Field>
            {f.countryMode !== 'all' && (
              <Field label="Country codes" htmlFor="sm-countries" hint="2-letter codes separated by commas, e.g. US, CA, PR.">
                <input id="sm-countries" className="input font-mono text-xs uppercase" value={f.countries} onChange={(e) => set('countries', e.target.value)} onBlur={() => set('countries', parseCountries(f.countries).join(', '))} />
              </Field>
            )}
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand mt-0.5" checked={f.requireCountry} onChange={(e) => set('requireCountry', e.target.checked)} />
              <span>Only offer once the customer has entered a destination country<span className="block text-xs text-gray-400">Otherwise the method may show before the address is filled in.</span></span>
            </label>
          </fieldset>

          <div className="rounded-lg bg-surface-2 border border-line px-3 py-2.5 text-sm" aria-live="polite">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">What customers will see</div>
            {summarizeCalculator(payload.calculator, currency)}
          </div>
          {errors.length > 0 && <InlineAlert tone="attention"><ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul></InlineAlert>}
          {save.error && <InlineAlert tone="critical">{(save.error as Error).message}</InlineAlert>}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-4 py-3">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={errors.length > 0 || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner className="text-white" /> : 'Save method'}</button>
        </div>
      </aside>
    </>
  );
}
