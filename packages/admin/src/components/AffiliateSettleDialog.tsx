import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';
import { money, date } from '../lib/format';
import { Modal, ErrorNote, Spinner } from './ui';

/**
 * Record an affiliate payout (DD SettleDialog.tsx): shows who is being paid,
 * the period, qualifying orders and the amount, with optional payment
 * reference and notes. The amount sent is exactly the outstanding figure the
 * operator confirmed — the server re-checks it against what is really owed.
 */
export function AffiliateSettleDialog({ open, affiliateId, email, currency, outstanding, orderCount, periodStart, onClose, onSettled }: {
  open: boolean; affiliateId: string; email: string; currency: string;
  /** Outstanding commission in cents. */
  outstanding: number; orderCount: number;
  /** End of the previous payout period (null = first payout). */
  periodStart: string | null;
  onClose: () => void; onSettled: () => void;
}) {
  const [txRef, setTxRef] = useState('');
  const [notes, setNotes] = useState('');
  const settle = useMutation({
    mutationFn: () => api.post(`/affiliates/${affiliateId}/settle`, { amountCents: outstanding, txRef: txRef.trim() || undefined, notes: notes.trim() || undefined }),
    onSuccess: () => { setTxRef(''); setNotes(''); onSettled(); },
  });
  const close = () => { if (!settle.isPending) { settle.reset(); onClose(); } };

  return (
    <Modal open={open} title={`Record payout to ${email}`} onClose={close}>
      <div className="text-sm">
        <div className="flex justify-between py-1.5 border-b border-gray-100"><span className="text-gray-500">Period</span><span>{periodStart ? date(periodStart) : 'Start'} → today</span></div>
        <div className="flex justify-between py-1.5 border-b border-gray-100"><span className="text-gray-500">Qualifying orders</span><span>{orderCount}</span></div>
        <div className="flex justify-between py-2"><span className="font-medium">Amount to pay</span><span className="text-lg font-semibold text-warning">{money(outstanding, currency)}</span></div>
      </div>
      <label className="label mt-2" htmlFor="aff-settle-ref">Payment reference (optional)</label>
      <input id="aff-settle-ref" className="input mb-3" placeholder="PayPal txn id, bank ref…" value={txRef} onChange={(e) => setTxRef(e.target.value)} disabled={settle.isPending} />
      <label className="label" htmlFor="aff-settle-notes">Notes (optional)</label>
      <input id="aff-settle-notes" className="input mb-3" placeholder="Any context for the audit log" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={settle.isPending} />
      {settle.error && <div className="mb-3"><ErrorNote message={(settle.error as Error).message} /></div>}
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={close} disabled={settle.isPending}>Cancel</button>
        <button className="btn-primary" disabled={settle.isPending || outstanding <= 0} onClick={() => settle.mutate()}>
          {settle.isPending ? <Spinner className="text-white" /> : `I've paid ${money(outstanding, currency)}`}
        </button>
      </div>
    </Modal>
  );
}
