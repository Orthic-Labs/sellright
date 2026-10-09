import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api';
import { useToast } from '../Toast';
import { useConfirmDialog } from '../ConfirmDialog';
import { FormSection } from '../ui';
import { money, dateTime } from '../../lib/format';
import type { EditContext } from './types';

type Action = 'retry' | 'credit';
interface Props {
  code: string; currency: string;
  payments: { id: string; method: string; amount: number; state: string }[];
  onChanged: () => void;
}

function statusLabel(s: { type?: string; status?: string } | null): string | null {
  if (!s?.type) return null;
  if (s.type === 'refund_now') return s.status === 'failed' ? 'Refund failed' : s.status === 'pending' ? 'Refund pending' : s.status === 'settled' ? 'Refund settled' : 'Refund';
  if (s.type === 'leave_credit') return 'Left as credit';
  return s.status ? `${s.type.replace(/_/g, ' ')} (${s.status})` : s.type.replace(/_/g, ' ');
}

/** Order edit history with recovery actions for edits whose refund failed. */
export function EditHistory({ code, currency, payments, onChanged }: Props) {
  const toast = useToast();
  const { confirm, dialog } = useConfirmDialog();
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['order-edit-context', code], queryFn: () => api.get<EditContext>(`/orders/${encodeURIComponent(code)}/edit/context`) });
  const history = q.data?.history ?? [];
  if (!history.length) return null;
  const settled = payments.filter((p) => p.state === 'Settled');

  const run = async (editId: string, action: Action) => {
    const ok = await confirm(action === 'retry'
      ? { title: 'Retry this refund?', description: 'The refund will be sent to the payment gateway again.', confirmLabel: 'Retry refund' }
      : { title: 'Keep as store credit?', description: 'The refund is abandoned and the amount stays as credit on the order.', confirmLabel: 'Keep as credit' });
    if (!ok) return;
    setBusy(editId);
    try {
      const paymentId = action === 'retry' ? (pick[editId] || undefined) : undefined;
      const r = await api.post<{ settlement: { status?: string; message?: string } }>(`/orders/${encodeURIComponent(code)}/edit/${encodeURIComponent(editId)}/refund`, { action, ...(paymentId ? { paymentId } : {}) });
      const s = r?.settlement;
      if (action === 'credit') toast.success('Kept as store credit');
      else if (s?.status === 'failed') toast.error('Refund failed again', s.message ?? 'Retry later or keep it as store credit.');
      else toast.success('Refund retried', s?.status ? `Refund ${s.status}` : undefined);
      onChanged();
    } catch (e) {
      toast.error(action === 'retry' ? 'Retry failed' : 'Could not keep as credit', e instanceof ApiError || e instanceof Error ? e.message : 'unexpected error');
    } finally { setBusy(null); }
  };

  return (
    <FormSection title="Edit history">
      {dialog}
      <ul className="divide-y divide-gray-100">
        {history.map((h) => {
          const failed = h.settlement?.type === 'refund_now' && h.settlement.status === 'failed';
          const label = statusLabel(h.settlement);
          return (
            <li key={h.id} className="py-2 text-sm" data-testid={`edit-${h.id}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-600">{dateTime(h.createdAt)}{h.actor ? ` · ${h.actor}` : ''}{h.reason ? ` · ${h.reason}` : ''}</span>
                <span className="text-gray-500">
                  {h.grandTotalBefore != null && h.grandTotalAfter != null ? `${money(h.grandTotalBefore, currency)} → ${money(h.grandTotalAfter, currency)}` : ''}
                </span>
              </div>
              {label && <div className={failed ? 'text-red-700 font-medium' : 'text-gray-500'}>{label}{failed && h.settlement?.message ? ` — ${h.settlement.message}` : ''}</div>}
              {failed && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {settled.length > 1 && (
                    <select className="input" aria-label="Refund payment" value={pick[h.id] ?? ''} onChange={(e) => setPick((m) => ({ ...m, [h.id]: e.target.value }))}>
                      <option value="">Original payment</option>
                      {settled.map((p) => <option key={p.id} value={p.id}>{p.method} · {money(p.amount, currency)}</option>)}
                    </select>
                  )}
                  <button className="btn-primary" disabled={busy === h.id} onClick={() => run(h.id, 'retry')}>Retry refund</button>
                  <button className="btn-ghost" disabled={busy === h.id} onClick={() => run(h.id, 'credit')}>Keep as store credit</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </FormSection>
  );
}
