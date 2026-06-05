import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Copy } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { money, dateTime } from '../lib/format';
import { Loading, ErrorNote, Badge, Spinner } from '../components/ui';

interface Detail {
  id: string; email: string; code: string; accessToken: string; commissionPct: number;
  earned: number; settled: number; unsettled: number; orders: { code: string; subtotal: number; state: string; commission: number; createdAt: string }[];
  settlements: { amountCents: number; settledAt: string; txRef: string | null; notes: string | null }[];
}

export default function AffiliateDetailPage() {
  const { id = '' } = useParams();
  const { store } = useAuth();
  const qc = useQueryClient();
  const cur = store?.currency ?? 'USD';
  const [txRef, setTxRef] = useState('');

  const key = ['affiliate', store?.slug, id];
  const { data: a, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/affiliates/${id}`) });
  const settle = useMutation({ mutationFn: () => api.post(`/affiliates/${id}/settle`, { txRef: txRef || undefined }), onSuccess: () => { setTxRef(''); qc.invalidateQueries({ queryKey: key }); } });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote message={(error as Error).message} />;
  if (!a) return null;
  const dashUrl = `${location.origin}/affiliate?t=${a.accessToken}`;

  return (
    <>
      <Link to="/affiliates" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Affiliates</Link>
      <h1 className="text-xl font-semibold tracking-tight mb-1">{a.email}</h1>
      <div className="text-sm text-gray-500 mb-5">Code <span className="font-mono">{a.code}</span> · {a.commissionPct}% commission</div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="card p-4"><div className="text-xs text-gray-500">Earned</div><div className="text-xl font-semibold">{money(a.earned, cur)}</div></div>
        <div className="card p-4"><div className="text-xs text-gray-500">Paid out</div><div className="text-xl font-semibold">{money(a.settled, cur)}</div></div>
        <div className="card p-4"><div className="text-xs text-gray-500">Outstanding</div><div className="text-xl font-semibold text-amber-600">{money(a.unsettled, cur)}</div></div>
      </div>

      <div className="card p-4 mb-5">
        <div className="text-sm font-semibold mb-2">Self-serve dashboard link</div>
        <div className="flex items-center gap-2">
          <input className="input font-mono text-xs" readOnly value={dashUrl} />
          <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(dashUrl)}><Copy size={15} /></button>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Attributed orders ({a.orders.length})</div>
          <table className="w-full">
            <thead><tr><th className="th">Order</th><th className="th">Status</th><th className="th text-right">Subtotal</th><th className="th text-right">Commission</th></tr></thead>
            <tbody>
              {a.orders.map((o) => (
                <tr key={o.code} className="border-t border-gray-100"><td className="td font-mono text-sm">{o.code}</td><td className="td"><Badge value={o.state} /></td><td className="td text-right">{money(o.subtotal, cur)}</td><td className="td text-right font-medium">{money(o.commission, cur)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-5">
          <div className="card p-4">
            <div className="text-sm font-semibold mb-2">Record payout</div>
            <input className="input mb-2" placeholder="payment reference (optional)" value={txRef} onChange={(e) => setTxRef(e.target.value)} />
            {settle.error && <div className="mb-2"><ErrorNote message={(settle.error as Error).message} /></div>}
            <button className="btn-primary w-full" disabled={a.unsettled <= 0 || settle.isPending} onClick={() => { if (confirm(`Record a payout of ${money(a.unsettled, cur)} to ${a.email}?`)) settle.mutate(); }}>
              {settle.isPending ? <Spinner className="text-white" /> : `Pay outstanding ${money(a.unsettled, cur)}`}
            </button>
          </div>
          {a.settlements.length > 0 && (
            <div className="card p-4">
              <div className="text-sm font-semibold mb-2">Payout history</div>
              {a.settlements.map((sx, i) => <div key={i} className="flex justify-between text-sm py-0.5"><span className="text-gray-500">{dateTime(sx.settledAt)}</span><span className="font-medium">{money(sx.amountCents, cur)}</span></div>)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
