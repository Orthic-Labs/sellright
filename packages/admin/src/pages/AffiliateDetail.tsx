import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Copy } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { money, date } from '../lib/format';
import { Loading, ErrorNote, Badge, Spinner } from '../components/ui';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { AffiliateSkuStats } from '../components/AffiliateSkuStats';
import { AffiliateSettleDialog } from '../components/AffiliateSettleDialog';
import { AFFILIATE_STATUS_TONE, affiliateDashboardLink, type AffiliateStatus } from '../components/AffiliateShared';

interface Detail {
  id: string; email: string; code: string; status: AffiliateStatus; accessToken: string; commissionPct: number;
  earned: number; settled: number; unsettled: number;
  topSellers: { name: string; sku: string; qtySold: number; revenue: number }[];
  /** Commission-earning orders only; `basis` = subtotal - discount, the figure commission is taken on (same as the totals). */
  orders: { code: string; state: string; subtotal: number; discountTotal: number; basis: number; commission: number; placedAt: string | null; createdAt: string }[];
  settlements: { amountCents: number; periodStartAt: string | null; periodEndAt: string; settledAt: string; txRef: string | null; notes: string | null }[];
}

export default function AffiliateDetailPage() {
  const { id = '' } = useParams();
  const { store } = useAuth();
  const qc = useQueryClient();
  const cur = store?.currency ?? 'USD';
  const [settleOpen, setSettleOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const key = ['affiliate', store?.slug, id];
  const { data: a, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/affiliates/${id}`) });
  // Existing PATCH: same-email is a no-op; a new email rotates the token (old link dies) and mails the new recipient.
  const reassign = useMutation({
    mutationFn: (next: string) => api.patch<{ id: string; email: string }>(`/affiliates/${id}`, { email: next }),
    onSuccess: () => { setEmail(''); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['affiliates', store?.slug] }); },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote message={(error as Error).message} />;
  if (!a) return null;
  const dashUrl = affiliateDashboardLink(location.origin, a.accessToken);
  const lastEnd = a.settlements[0]?.periodEndAt ?? null;
  const canSettle = a.unsettled > 0 && a.status !== 'Deleted';
  const nextEmail = email.trim().toLowerCase();
  const canReassign = !!nextEmail && nextEmail.includes('@') && nextEmail !== a.email && !reassign.isPending;

  const copy = async () => {
    try { await navigator.clipboard.writeText(dashUrl); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { window.prompt('Copy this link:', dashUrl); }
  };

  return (
    <>
      {confirmDialog}
      <Link to="/affiliates" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Affiliates</Link>
      <h1 className="text-xl font-semibold tracking-tight mb-1">{a.email}</h1>
      <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500 mb-5">
        <span className="font-mono">{a.code}</span>
        <Badge value={a.status} tone={AFFILIATE_STATUS_TONE[a.status] ?? 'neutral'} />
        <span>{a.commissionPct}% commission · {a.orders.length} qualifying {a.orders.length === 1 ? 'order' : 'orders'}</span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="card p-4"><div className="text-xs text-gray-500">Earned</div><div className="text-xl font-semibold">{money(a.earned, cur)}</div></div>
        <div className="card p-4"><div className="text-xs text-gray-500">Paid out</div><div className="text-xl font-semibold">{money(a.settled, cur)}</div><div className="text-xs text-gray-400 mt-0.5">Across {a.settlements.length} {a.settlements.length === 1 ? 'settle' : 'settles'}</div></div>
        <div className="card p-4"><div className="text-xs text-gray-500">Outstanding</div><div className="text-xl font-semibold text-warning">{money(a.unsettled, cur)}</div></div>
      </div>

      <div className="card p-4 mb-5">
        <div className="text-sm font-semibold mb-2">Self-serve dashboard link</div>
        <div className="flex items-center gap-2">
          <input className="input font-mono text-xs" readOnly value={dashUrl} />
          <button className="btn-ghost" aria-label="Copy dashboard link" onClick={copy}><Copy size={15} />{copied && <span className="ml-1 text-xs">Copied</span>}</button>
        </div>
        <div className="text-sm font-semibold mt-4 mb-2">Recipient</div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input flex-1 min-w-[14rem]" type="email" aria-label="New recipient email" placeholder={a.email} value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn-ghost" disabled={!canReassign} onClick={async () => {
            if (await confirm({ title: `Send ${a.code} to ${nextEmail}?`, description: 'The current dashboard link stops working immediately and a new one is emailed to the new address.', confirmLabel: 'Change recipient' })) reassign.mutate(nextEmail);
          }}>{reassign.isPending ? <Spinner /> : 'Change recipient'}</button>
        </div>
        {reassign.error && <div className="mt-2"><ErrorNote message={(reassign.error as Error).message} /></div>}
      </div>

      {a.topSellers.length > 0 && (
        <div className="card overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Top sellers</div>
          <table className="w-full">
            <thead><tr><th className="th">Product</th><th className="th">SKU</th><th className="th text-right">Qty</th><th className="th text-right">Revenue</th></tr></thead>
            <tbody>
              {a.topSellers.map((p) => (
                <tr key={p.sku} className="border-t border-gray-100"><td className="td">{p.name}</td><td className="td font-mono text-xs">{p.sku}</td><td className="td text-right">{p.qtySold}</td><td className="td text-right">{money(p.revenue, cur)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mb-5"><AffiliateSkuStats affiliateId={id} /></div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Qualifying orders ({a.orders.length})</div>
          <table className="w-full">
            <thead><tr><th className="th">Order</th><th className="th">Date</th><th className="th">Status</th><th className="th text-right">Net subtotal</th><th className="th text-right">Commission</th></tr></thead>
            <tbody>
              {a.orders.length === 0 && <tr><td className="td text-gray-500" colSpan={5}>No qualifying orders yet.</td></tr>}
              {a.orders.map((o) => (
                <tr key={o.code} className="border-t border-gray-100">
                  <td className="td font-mono text-sm">{o.code}</td>
                  <td className="td text-gray-500">{date(o.placedAt ?? o.createdAt)}</td>
                  <td className="td"><Badge value={o.state} /></td>
                  <td className="td text-right" title={o.discountTotal > 0 ? `${money(o.subtotal, cur)} less ${money(o.discountTotal, cur)} discount` : undefined}>{money(o.basis, cur)}</td>
                  <td className="td text-right font-medium">{money(o.commission, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="stack-y-5">
          <div className="card p-4">
            <div className="text-sm font-semibold mb-2">Record payout</div>
            <button className="btn-primary w-full" disabled={!canSettle} onClick={() => setSettleOpen(true)}>
              {canSettle ? `Settle ${money(a.unsettled, cur)}` : 'Nothing owed'}
            </button>
          </div>
          {a.settlements.length > 0 && (
            <div className="card p-4">
              <div className="text-sm font-semibold mb-2">Payout history</div>
              {a.settlements.map((sx, i) => (
                <div key={i} className="py-1.5 border-t border-gray-100 first:border-t-0 text-sm">
                  <div className="flex justify-between"><span className="text-gray-500">{date(sx.settledAt)}</span><span className="font-medium">{money(sx.amountCents, cur)}</span></div>
                  <div className="text-xs text-gray-400">{sx.periodStartAt ? `${date(sx.periodStartAt)} → ${date(sx.periodEndAt)}` : `Up to ${date(sx.periodEndAt)}`}</div>
                  {sx.txRef && <div className="text-xs font-mono text-gray-500">{sx.txRef}</div>}
                  {sx.notes && <div className="text-xs text-gray-500">{sx.notes}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AffiliateSettleDialog
        open={settleOpen} affiliateId={id} email={a.email} currency={cur}
        outstanding={a.unsettled} orderCount={a.orders.length} periodStart={lastEnd}
        onClose={() => setSettleOpen(false)}
        onSettled={() => { setSettleOpen(false); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['affiliates', store?.slug] }); }}
      />
    </>
  );
}
