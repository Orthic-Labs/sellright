import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { FormSection, Field, InlineAlert, Spinner } from './ui';

export interface OrderNumberingSettings {
  prefix: string; suffix: string; minDigits: number; nextNumber: number;
  preview: string; highestExisting: string | null;
}
interface Draft { prefix: string; suffix: string; minDigits: string; nextNumber: string }

/** Mirrors the API's formatOrderCode (packages/api/src/orders/order-number.ts): prefix + zero-padded number + suffix. */
export function previewOrderCode(d: Draft): string | null {
  const n = Number(d.nextNumber), digits = Number(d.minDigits || '0');
  if (!/^\d+$/.test(d.nextNumber) || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(digits) || digits < 0 || digits > 12) return null;
  return d.prefix + String(n).padStart(digits, '0') + d.suffix;
}

const toDraft = (s: OrderNumberingSettings): Draft => ({ prefix: s.prefix, suffix: s.suffix, minDigits: String(s.minDigits), nextNumber: String(s.nextNumber) });

/** Settings > Order numbers (#309): the store's sequential order code format and next number. */
export function OrderNumbering({ canManage }: { canManage: boolean }) {
  const { store } = useAuth();
  const qc = useQueryClient();
  const key = ['settings-order-numbering', store?.slug];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<OrderNumberingSettings>('/settings/order-numbering') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({
    mutationFn: (d: Draft) => api.patch<OrderNumberingSettings>('/settings/order-numbering', {
      prefix: d.prefix.trim(), suffix: d.suffix.trim(), minDigits: Number(d.minDigits || '0'), nextNumber: Number(d.nextNumber),
    }),
    onSuccess: (saved) => { qc.setQueryData(key, saved); setDraft(null); },
  });
  const set = (k: keyof Draft) => (e: ChangeEvent<HTMLInputElement>) => { save.reset(); setDraft((d) => d && { ...d, [k]: e.target.value }); };

  const data = q.data;
  const preview = draft ? previewOrderCode({ ...draft, prefix: draft.prefix.trim(), suffix: draft.suffix.trim() }) : null;
  return (
    <FormSection title="Order numbers" description="How new orders are numbered. Existing and imported orders keep their numbers."
      actions={draft && <>
        <button className="btn-ghost" onClick={() => { save.reset(); setDraft(null); }}>Cancel</button>
        <button className="btn-primary" disabled={save.isPending || !preview} onClick={() => save.mutate(draft)}>{save.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
      </>}>
      {q.error && <InlineAlert tone="critical">{(q.error as Error).message}</InlineAlert>}
      {!data && !q.error && <Spinner />}
      {data && !draft && (
        <>
          <dl className="stack-y-2.5 text-sm">
            <div className="flex justify-between max-w-md"><dt className="text-gray-500">Next order</dt><dd className="font-mono font-medium">{data.preview}</dd></div>
            <div className="flex justify-between max-w-md"><dt className="text-gray-500">Prefix</dt><dd className="font-mono">{data.prefix || '—'}</dd></div>
            <div className="flex justify-between max-w-md"><dt className="text-gray-500">Suffix</dt><dd className="font-mono">{data.suffix || '—'}</dd></div>
            <div className="flex justify-between max-w-md"><dt className="text-gray-500">Minimum digits</dt><dd className="tnum">{data.minDigits || 'No padding'}</dd></div>
            {data.highestExisting && <div className="flex justify-between max-w-md"><dt className="text-gray-500">Highest existing in this format</dt><dd className="font-mono">{data.highestExisting}</dd></div>}
          </dl>
          {canManage
            ? <button className="btn-ghost btn-sm" onClick={() => setDraft(toDraft(data))}>Edit order numbers</button>
            : <InlineAlert tone="neutral">Only owners and managers can change order numbers.</InlineAlert>}
        </>
      )}
      {draft && (
        <>
          <div className="grid sm:grid-cols-2 gap-4 max-w-xl">
            <Field label="Prefix" htmlFor="on-prefix" hint="Optional, e.g. DD, RH or #."><input id="on-prefix" className="input font-mono" maxLength={16} value={draft.prefix} onChange={set('prefix')} /></Field>
            <Field label="Suffix" htmlFor="on-suffix" hint="Optional."><input id="on-suffix" className="input font-mono" maxLength={16} value={draft.suffix} onChange={set('suffix')} /></Field>
            <Field label="Minimum digits" htmlFor="on-digits" hint="Pads with zeros; 0 for none."><input id="on-digits" className="input tnum" inputMode="numeric" value={draft.minDigits} onChange={set('minDigits')} /></Field>
            <Field label="Next number" htmlFor="on-next" hint={data?.highestExisting ? `Must be above ${data.highestExisting} if the format matches it.` : 'The number the next order gets.'}>
              <input id="on-next" className="input tnum" inputMode="numeric" value={draft.nextNumber} onChange={set('nextNumber')} />
            </Field>
          </div>
          <p className="text-sm">Next order: <span className="font-mono font-medium" data-testid="order-number-preview">{preview ?? '—'}</span></p>
          {save.error && <InlineAlert tone="critical">{(save.error as Error).message}</InlineAlert>}
        </>
      )}
    </FormSection>
  );
}
