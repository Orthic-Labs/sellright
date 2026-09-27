import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from './Toast';
import { EmptyState, Field, FormSection, InlineAlert, Spinner } from './ui';
import { dateTime, money } from '../lib/format';

export interface CustomerLoyaltyData {
  customerId: string;
  enabled: boolean;
  balance: number;
  available: number;
  pendingExpiry: number;
  availableValue: number;
  ledger: Array<{
    id: string; kind: string; points: number; shortfall: number; reason: string | null; actor: string | null;
    orderCode: string | null; expiresAt: string | null; createdAt: string;
  }>;
}

const KIND_LABEL: Record<string, string> = {
  earn: 'Earned', redeem: 'Redeemed', reverse: 'Reversal', adjust: 'Adjustment', expire: 'Expired', import: 'Imported',
};

/** Per-customer points balance, append-only ledger, and a manual adjustment
 *  form (server enforces the `loyalty` permission + writes audit_log). */
export function CustomerLoyalty({ customerId }: { customerId: string }) {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cur = store?.currency ?? 'USD';
  const key = ['customer-loyalty', store?.slug, customerId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<CustomerLoyaltyData>(`/customers/${customerId}/loyalty`) });
  const [adj, setAdj] = useState<{ points: string; reason: string } | null>(null);
  const adjust = useMutation({
    mutationFn: () => api.post<CustomerLoyaltyData>(`/customers/${customerId}/loyalty/adjust`, {
      points: Number(adj!.points), reason: adj!.reason.trim(), idempotencyKey: crypto.randomUUID(),
    }),
    onSuccess: (next) => { qc.setQueryData(key, next); setAdj(null); toast.success('Points adjusted'); },
  });

  if (error) return <FormSection title="Points"><InlineAlert tone="critical">{(error as Error).message}</InlineAlert></FormSection>;
  if (!data) return <FormSection title="Points"><Spinner /></FormSection>;
  const pts = Number(adj?.points);
  const adjValid = !!adj && Number.isInteger(pts) && pts !== 0 && adj.reason.trim().length >= 3;

  return (
    <FormSection
      title="Points"
      description={data.enabled ? 'Balance is the sum of the ledger below.' : 'Points program is off — balances are kept.'}
      actions={!adj ? <button className="btn-ghost text-xs" onClick={() => setAdj({ points: '', reason: '' })}>Adjust</button> : undefined}
    >
      <div className="text-sm space-y-1 mb-3">
        <div><span className="text-gray-500">Available:</span> <span className="font-medium tnum">{data.available.toLocaleString()}</span> <span className="text-gray-500">({money(data.availableValue, cur)})</span></div>
        {data.pendingExpiry > 0 && <div className="text-warning">{data.pendingExpiry.toLocaleString()} points expired, written off on next use</div>}
      </div>
      {adj && (
        <form className="space-y-2 mb-3" onSubmit={(e) => { e.preventDefault(); if (adjValid) adjust.mutate(); }}>
          <Field label="Points (+ to add, − to remove)"><input className="input" inputMode="numeric" value={adj.points} onChange={(e) => setAdj({ ...adj, points: e.target.value })} autoFocus /></Field>
          <Field label="Reason (recorded in the activity log)"><input className="input" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
          {adjust.error && <InlineAlert tone="critical">{(adjust.error as Error).message}</InlineAlert>}
          <div className="flex gap-2">
            <button className="btn-primary text-xs" disabled={!adjValid || adjust.isPending}>{adjust.isPending ? <Spinner className="text-white" /> : 'Apply'}</button>
            <button type="button" className="btn-ghost text-xs" onClick={() => { setAdj(null); adjust.reset(); }}>Cancel</button>
          </div>
        </form>
      )}
      {data.ledger.length === 0 ? <EmptyState title="No points activity" /> : (
        <table className="w-full text-sm">
          <thead><tr><th className="th">When</th><th className="th">Type</th><th className="th text-right">Points</th></tr></thead>
          <tbody>
            {data.ledger.map((r) => (
              <tr key={r.id} className="border-t border-gray-100" title={[r.reason, r.actor].filter(Boolean).join(' · ')}>
                <td className="td text-gray-500">{dateTime(r.createdAt)}</td>
                <td className="td">{KIND_LABEL[r.kind] ?? r.kind}{r.orderCode ? <span className="text-gray-500"> · {r.orderCode}</span> : null}
                  {r.shortfall > 0 && <span className="text-warning"> · {r.shortfall} short</span>}</td>
                <td className={`td text-right tnum ${r.points < 0 ? 'text-critical' : ''}`}>{r.points > 0 ? '+' : ''}{r.points.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </FormSection>
  );
}
