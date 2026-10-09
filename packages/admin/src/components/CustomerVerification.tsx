import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from './Toast';
import { date, dateTime } from '../lib/format';
import { EmptyState, Field, FormSection, InlineAlert, Modal, Spinner, StatusBadge } from './ui';

export interface CustomerVerificationData {
  customerId: string;
  active: string[];
  entries: { category: string; programId: string | null; discountPercent: number | null; verifiedAt: string | null; expiresAt: string | null; source: 'sheerid' | 'imported' }[];
  attempts: { id: string; category: string | null; status: string; createdAt: string; expiresAt: string | null }[];
  history: { action: string; actor: string | null; at: string; categories: string[]; reason: string | null }[];
  canClear: boolean;
}

const ACTION_LABEL: Record<string, string> = { verification_cleared: 'Verification cleared', verification_revoked: 'Category revoked' };

/** Whether the form can be submitted: a real reason (server minimum is 3 characters). */
export const reasonOk = (reason: string) => reason.trim().length >= 3;

/** SheerID verification state for one customer, with a permission-gated "Clear verification" action (G12). */
export function CustomerVerification({ customerId }: { customerId: string }) {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['customer-verification', store?.slug, customerId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<CustomerVerificationData>(`/customers/${customerId}/verification`) });
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [reason, setReason] = useState('');

  const clear = useMutation({
    mutationFn: () => api.post<{ cleared: string[] }>(`/customers/${customerId}/verification/clear`, { reason: reason.trim(), ...(category ? { category } : {}) }),
    onSuccess: (r) => {
      setOpen(false); setReason(''); setCategory('');
      qc.invalidateQueries({ queryKey: key });
      toast.success(r.cleared.length ? `Cleared ${r.cleared.join(', ')}` : 'Nothing to clear');
    },
  });

  if (error) return <FormSection title="Verification"><InlineAlert tone="critical">{(error as Error).message}</InlineAlert></FormSection>;
  if (!data) return <FormSection title="Verification"><Spinner /></FormSection>;
  const categories = [...new Set(data.entries.map((e) => e.category))];

  return (
    <FormSection title="Verification" description="Student / military / etc. status from SheerID"
      actions={data.canClear && data.active.length > 0 ? <button className="btn-ghost text-danger" onClick={() => { clear.reset(); setOpen(true); }}>Clear verification</button> : undefined}>
      {data.entries.length === 0 && data.history.length === 0 ? <EmptyState title="Not verified" /> : (
        <div className="space-y-3 text-sm">
          {data.entries.length === 0 ? <div className="text-gray-500">No active verification.</div> : data.entries.map((e) => (
            <div key={e.category} className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium capitalize">{e.category}{e.discountPercent ? <span className="ml-2 text-xs font-normal text-gray-500">{e.discountPercent}% off</span> : null}</div>
                <div className="text-xs text-gray-500">{e.source === 'imported' ? 'Imported' : 'SheerID'}{e.verifiedAt ? ` · verified ${date(e.verifiedAt)}` : ''}{e.expiresAt ? ` · expires ${date(e.expiresAt)}` : ''}</div>
              </div>
              <StatusBadge value="active" label="Active" />
            </div>
          ))}
          {data.history.length > 0 && (
            <div className="border-t border-gray-100 pt-3">
              <div className="text-xs font-semibold text-gray-500 mb-1">History</div>
              {data.history.map((h, i) => (
                <div key={i} className="text-xs text-gray-600 mb-1.5">
                  <span className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</span>{h.categories.length ? ` (${h.categories.join(', ')})` : ''} · {h.actor ?? 'system'} · {dateTime(h.at)}
                  {h.reason && <div className="text-gray-500">“{h.reason}”</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Clear verification">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">The customer loses access to verified-only discounts right away and will have to verify again. This is recorded in the activity log with your name and reason.</p>
          <Field label="What to clear" htmlFor="ver-cat">
            <select id="ver-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All verification{categories.length ? ` (${categories.join(', ')})` : ''}</option>
              {categories.map((c) => <option key={c} value={c}>Only {c}</option>)}
            </select>
          </Field>
          <Field label="Reason" htmlFor="ver-reason" hint="Required, at least 3 characters.">
            <textarea id="ver-reason" className="input" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {clear.error && <InlineAlert tone="critical">{(clear.error as Error).message}</InlineAlert>}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" disabled={!reasonOk(reason) || clear.isPending} onClick={() => clear.mutate()}>{clear.isPending ? <Spinner className="text-white" /> : 'Clear verification'}</button>
          </div>
        </div>
      </Modal>
    </FormSection>
  );
}
