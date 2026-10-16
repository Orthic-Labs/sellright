import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

/** States the API treats as "paid" for purge (admin-order-ops.ts bulk-purge): these need force + a written reason. */
const PAID_PURGE_STATES = new Set(['Paid', 'PartiallyRefunded', 'Refunded']);
export const isPaidPurgeState = (state: string): boolean => PAID_PURGE_STATES.has(state);

interface PurgePrompt { total: number; paidCodes: string[]; resolve: (reason: string | null) => void }

/**
 * Confirm dialog for permanently deleting trashed orders when at least one of them is paid. Purging a paid order wipes
 * its payment, refund and fulfilment records, so the API only allows it with force + a reason (kept in the audit log);
 * the confirm button stays disabled until a reason is typed. `ask()` resolves with the trimmed reason, or null on cancel.
 */
export function useForcePurgeDialog() {
  const [prompt, setPrompt] = useState<PurgePrompt | null>(null);
  const ask = useCallback((total: number, paidCodes: string[]) => new Promise<string | null>((resolve) => setPrompt({ total, paidCodes, resolve })), []);
  const dialog = prompt && (
    <ForcePurgeDialog
      total={prompt.total}
      paidCodes={prompt.paidCodes}
      onCancel={() => { prompt.resolve(null); setPrompt(null); }}
      onConfirm={(reason) => { prompt.resolve(reason); setPrompt(null); }}
    />
  );
  return { ask, dialog };
}

function ForcePurgeDialog({ total, paidCodes, onCancel, onConfirm }: { total: number; paidCodes: string[]; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const valid = reason.trim().length > 0;

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 animate-fade-in" onClick={onCancel} aria-hidden="true" />
      <div className="fixed inset-x-0 top-[15vh] z-50 mx-auto w-full max-w-md px-3" role="alertdialog" aria-modal="true" aria-labelledby="force-purge-title" aria-describedby="force-purge-desc">
        <form className="card p-5 shadow-lg" onSubmit={(e) => { e.preventDefault(); if (valid) onConfirm(reason.trim()); }}>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger-soft text-danger" aria-hidden="true"><AlertTriangle size={18} /></span>
            <div className="min-w-0">
              <h2 id="force-purge-title" className="text-sm font-semibold text-ink">Permanently delete {total} order{total === 1 ? '' : 's'}?</h2>
              <p id="force-purge-desc" className="mt-1.5 text-sm text-gray-500">
                {paidCodes.length === 1 ? '1 selected order is' : `${paidCodes.length} selected orders are`} paid ({paidCodes.join(', ')}).
                Deleting a paid order also deletes its payments, refunds and fulfilments. This cannot be undone; the reason below is kept in the audit log.
              </p>
            </div>
          </div>
          <label className="label mt-4" htmlFor="force-purge-reason">Reason (required)</label>
          <textarea id="force-purge-reason" ref={ref} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this paid order being deleted?" required />
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn-danger btn-sm" disabled={!valid}>Delete permanently</button>
          </div>
        </form>
      </div>
    </>
  );
}
