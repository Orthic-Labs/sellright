import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { api, ApiError } from '../../api';
import { useToast } from '../Toast';
import { FormSection, Field, InlineAlert, Spinner } from '../ui';
import { addressToWire, addressValid, storedToForm } from './ops';
import type { AddressForm } from './types';

/** Display lines for a stored order address (canonical or legacy Vendure-ish keys). */
export function addressLines(a: Record<string, unknown> | null): string[] {
  if (!a) return [];
  const g = (...ks: string[]) => { for (const k of ks) if (a[k] != null && String(a[k]).trim()) return String(a[k]); return ''; };
  return [
    g('fullName'),
    [g('line1', 'streetLine1'), g('line2', 'streetLine2')].filter(Boolean).join(', '),
    [g('city'), g('province', 'state'), g('postalCode', 'zip')].filter(Boolean).join(' '),
    g('country', 'countryCode'),
    g('phone'),
  ].filter(Boolean);
}

const FIELDS: Array<[keyof AddressForm, string, string]> = [
  ['fullName', 'Full name', 'col-span-2'], ['line1', 'Address line 1', 'col-span-2'], ['line2', 'Address line 2', 'col-span-2'],
  ['city', 'City', ''], ['province', 'State / province', ''], ['postalCode', 'Postal code', ''], ['country', 'Country (2-letter)', ''], ['phone', 'Phone', 'col-span-2'],
];

/**
 * Shipping / billing address card with an inline editor (G5). Saves straight to
 * the order — no customer address-book entry is required (guest orders work);
 * "also save to the customer's address book" is an opt-in, off by default. A
 * shipping COUNTRY change re-derives tax/shipping, so the API refuses a direct
 * save and this hands the staged address to the order-edit preview via
 * `onCountryChange`.
 */
export function AddressCard({ code, kind, address, canEdit, hasCustomer, onSaved, onCountryChange }: {
  code: string; kind: 'shipping' | 'billing'; address: Record<string, unknown> | null; canEdit: boolean; hasCustomer: boolean;
  onSaved: () => void; onCountryChange: (a: AddressForm, saveToAddressBook: boolean) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<AddressForm>(() => storedToForm(null));
  const [book, setBook] = useState(false);
  const [reason, setReason] = useState('');
  const title = kind === 'shipping' ? 'Shipping address' : 'Billing address';
  const lines = addressLines(address);

  const start = () => { setForm(storedToForm(address)); setBook(false); setReason(''); setEditing(true); };

  const save = useMutation({
    mutationFn: () => api.put<{ changed: boolean; savedToAddressBook: boolean }>(`/orders/${encodeURIComponent(code)}/address`, {
      kind, address: addressToWire(form), saveToAddressBook: book, reason: reason.trim() || undefined,
    }),
    onSuccess: (r) => { setEditing(false); onSaved(); toast.success(r.changed ? `${title} updated` : 'No changes to save'); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'COUNTRY_CHANGE_REQUIRES_EDIT') {
        setEditing(false); onCountryChange(form, book);
        toast.success('Country changed', 'Review the new tax and balance, then commit the edit.');
        return;
      }
      toast.error('Could not save address', e instanceof Error ? e.message : 'unexpected error');
    },
  });

  return (
    <FormSection title={title} actions={undefined}>
      {!editing ? (
        <div className="flex items-start justify-between gap-3">
          <div>
            {lines.length ? lines.map((l, i) => <div key={i} className="text-sm text-gray-600">{l}</div>) : <span className="text-sm text-gray-400">None</span>}
          </div>
          {canEdit && <button className="btn-ghost btn-sm shrink-0" onClick={start} aria-label={`Edit ${title.toLowerCase()}`}><Pencil size={13} /> Edit</button>}
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (addressValid(form)) save.mutate(); }}>
          <div className="grid grid-cols-2 gap-3">
            {FIELDS.map(([key, label, span]) => (
              <div key={key} className={span}>
                <Field label={label} htmlFor={`addr-${kind}-${key}`}>
                  <input
                    id={`addr-${kind}-${key}`} className="input" value={form[key]} maxLength={key === 'country' ? 2 : 200}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </Field>
              </div>
            ))}
          </div>
          {!addressValid(form) && <InlineAlert tone="attention">Address line 1, city and a 2-letter country code are required.</InlineAlert>}
          <Field label="Reason" hint="Optional — recorded on the order timeline">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer moved" />
          </Field>
          {hasCustomer && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-brand" checked={book} onChange={(e) => setBook(e.target.checked)} />
              Also save to the customer's address book
            </label>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={save.isPending || !addressValid(form)}>{save.isPending ? <Spinner className="text-white" /> : 'Save address'}</button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)} disabled={save.isPending}>Cancel</button>
          </div>
        </form>
      )}
    </FormSection>
  );
}
