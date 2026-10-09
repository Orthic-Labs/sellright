import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from './Toast';
import { Modal, InlineAlert, Spinner, Field } from './ui';
import { date } from '../lib/format';

interface Result { dryRun: boolean; days: number; cutoff: string; count: number; sample: { code: string; trackingCode: string | null; carrier: string | null; shippedAt: string }[] }

/** Orders > Actions > "Mark old shipments delivered": always previews first, then asks for confirmation. */
export default function AutoDeliverDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [days, setDays] = useState('10');
  const [preview, setPreview] = useState<Result | null>(null);
  const n = Number(days);
  const validDays = Number.isInteger(n) && n >= 1 && n <= 365;

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<Result>('/jobs/auto-deliver', { dryRun, days: n }),
    onSuccess: (r) => {
      if (r.dryRun) { setPreview(r); return; }
      toast.success(`${r.count} shipment${r.count === 1 ? '' : 's'} marked delivered`);
      void qc.invalidateQueries({ queryKey: ['orders', store?.slug] });
      onClose();
    },
    onError: (e) => toast.error('Could not run the delivered check', (e as Error).message),
  });

  // Fresh preview each time the dialog opens.
  useEffect(() => { if (open) { setPreview(null); run.mutate(true); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  const stale = !!preview && preview.days !== n;
  return (
    <Modal open={open} onClose={onClose} title="Mark old shipments delivered" width="max-w-xl">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">Shipments still marked <b>Shipped</b> for longer than the number of days below are marked <b>Delivered</b>. Nothing changes until you confirm.</p>
        <div className="flex items-end gap-2">
          <Field label="Shipped more than (days) ago" htmlFor="ad-days"><input id="ad-days" className="input w-24 tnum" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <button className="btn-ghost" disabled={!validDays || run.isPending} onClick={() => run.mutate(true)}>Preview</button>
        </div>
        {run.isPending && !preview && <div className="text-sm text-gray-400 flex items-center gap-2"><Spinner /> Checking…</div>}
        {preview && (
          <div className="space-y-2" aria-live="polite">
            <InlineAlert tone={preview.count ? 'attention' : 'neutral'} title={preview.count ? `${preview.count} shipment${preview.count === 1 ? '' : 's'} would be marked delivered` : 'Nothing to mark delivered'}>
              Shipped before {date(preview.cutoff)} ({preview.days} days ago or more).
            </InlineAlert>
            {preview.sample.length > 0 && (
              <div className="card overflow-hidden">
                <table className="w-full text-xs">
                  <thead><tr><th className="th text-left">Order</th><th className="th text-left">Tracking</th><th className="th text-left">Shipped</th></tr></thead>
                  <tbody>{preview.sample.map((s) => <tr key={`${s.code}${s.trackingCode}`}><td className="td font-medium">{s.code}</td><td className="td font-mono">{s.trackingCode ?? '—'}{s.carrier ? ` · ${s.carrier}` : ''}</td><td className="td text-gray-500">{date(s.shippedAt)}</td></tr>)}</tbody>
                </table>
                {preview.count > preview.sample.length && <div className="px-3 py-1.5 text-xs text-gray-400 border-t border-gray-100">Showing the oldest {preview.sample.length} of {preview.count}.</div>}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!preview || stale || preview.count === 0 || run.isPending} onClick={() => run.mutate(false)}>
            {run.isPending && preview ? <Spinner className="text-white" /> : stale ? 'Preview again first' : `Mark ${preview?.count ?? 0} delivered`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
