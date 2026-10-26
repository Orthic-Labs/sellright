import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner, Modal } from '../components/ui';
import { money, dateTime } from '../lib/format';

// Operator tooling for account credit (issue #395): the admin replacement for the old
// issue-test-credit / import-credits / maintain-credit scripts. Every action is audited server-side.

interface CreditAccount {
  id: string; code: string | null; email: string; currency: string;
  initialAmount: number; balance: number; held: number; available: number; disabled: boolean; createdAt: string;
}
interface LedgerRow {
  id: string; kind: string; status: string; amount: number; delta: number; balanceAfter: number | null;
  reason: string | null; actor: string | null; orderCode: string | null; createdAt: string;
}
interface RedeemedOrder {
  orderId: string; orderCode: string | null;
  lines: { id: string; name: string; quantity: number; unitCreditCents: number[] }[];
}
interface Detail { account: CreditAccount; ledger: LedgerRow[]; redeemedOrders: RedeemedOrder[] }
interface BatchResult {
  applied: boolean; count: number; totalCents: number; digest: string; errors: string[];
  issued: { row: number; email: string; amountCents: number; accountId: string; code: string; created: boolean }[];
}

/** "25", "25.5" or "25.00" to integer cents; null when malformed. A leading +/- is allowed when `signed`. */
function toCents(value: string, signed = false): number | null {
  const m = new RegExp(`^${signed ? '([+-]?)' : '()'}(\\d+)(?:\\.(\\d{1,2}))?$`).exec(value.trim());
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] === '-' ? -cents : cents;
}
const newKey = () => crypto.randomUUID();

export default function AccountCreditPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const listKey = ['account-credit', store?.slug, search];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => api.get<{ items: CreditAccount[] }>(`/account-credit${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['account-credit', store?.slug] });

  return (
    <>
      <PageHeader title="Account Credit" subtitle="Issue and maintain email-bound store credit. Every action is recorded in the audit log." />
      <IssueForms onDone={refresh} />
      <form className="card p-4 mb-4 flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <div className="flex-1">
          <label className="label" htmlFor="ac-search">Find by email or coupon code</label>
          <input id="ac-search" className="input w-full" value={q} onChange={(e) => setQ(e.target.value)} placeholder="customer@example.com or ACC-…" />
        </div>
        <button className="btn-primary">Search</button>
      </form>
      <div className="card overflow-hidden">
        {list.isLoading ? <Loading /> : list.error ? <ErrorNote message={(list.error as Error).message} />
          : !list.data || list.data.items.length === 0 ? <EmptyState title="No account credits found" />
          : (
            <table className="w-full">
              <thead><tr>
                <th className="th">Email</th><th className="th">Code</th><th className="th">Initial</th>
                <th className="th">Balance</th><th className="th">Held</th><th className="th">Status</th><th className="th" />
              </tr></thead>
              <tbody>
                {list.data.items.map((a) => (
                  <tr key={a.id} className="border-t border-gray-100">
                    <td className="td">{a.email}</td>
                    <td className="td font-mono">{a.code}</td>
                    <td className="td text-gray-500">{money(a.initialAmount, a.currency)}</td>
                    <td className="td font-medium">{money(a.balance, a.currency)}</td>
                    <td className="td text-gray-500">{money(a.held, a.currency)}</td>
                    <td className="td"><Badge value={a.disabled ? 'draft' : 'active'} label={a.disabled ? 'Disabled' : 'Active'} /></td>
                    <td className="td"><button className="btn-ghost text-xs" onClick={() => setSelected(a.id)}>Manage</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {selected && <ManageModal id={selected} onClose={() => setSelected(null)} onChanged={refresh} />}
    </>
  );
}

function IssueForms({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState<null | 'one' | 'batch'>(null);
  const [form, setForm] = useState({ email: '', amount: '', code: '', reason: '' });
  const [issuanceKey, setIssuanceKey] = useState(newKey);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [batch, setBatch] = useState({ name: '', rows: '', reason: '' });
  const [preview, setPreview] = useState<BatchResult | null>(null);

  const issue = useMutation({
    mutationFn: () => {
      const cents = toCents(form.amount);
      if (!cents) return Promise.reject(new Error('Enter the amount as dollars, e.g. 25.00'));
      return api.post<{ account: CreditAccount; created: boolean }>('/account-credit/issue', {
        email: form.email.trim(), amountCents: cents, issuanceKey, reason: form.reason.trim(),
        ...(form.code.trim() ? { code: form.code.trim() } : {}),
      });
    },
    onSuccess: (r) => {
      setDone(`${r.created ? 'Issued' : 'Already issued'}: ${r.account.code} (${money(r.account.balance, r.account.currency)} for ${r.account.email})`);
      setForm({ email: '', amount: '', code: '', reason: '' }); setIssuanceKey(newKey()); setErr(null); onDone();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const parsed = () => {
    const rows: { email: string; amountCents: number }[] = [];
    for (const [i, line] of batch.rows.split('\n').map((l) => l.trim()).entries()) {
      if (!line) continue;
      const [email, amount] = line.split(/[,\t]/).map((x) => x?.trim() ?? '');
      const cents = toCents(amount ?? '');
      if (!email || !cents) throw new Error(`Line ${i + 1}: expected "email, amount" in dollars`);
      rows.push({ email, amountCents: cents });
    }
    if (!rows.length) throw new Error('Add at least one "email, amount" line');
    return rows;
  };
  const runBatch = useMutation({
    mutationFn: (apply: boolean) => api.post<BatchResult>('/account-credit/issue-batch', {
      batch: batch.name.trim(), rows: parsed(), apply, reason: batch.reason.trim(), ...(apply && preview ? { digest: preview.digest } : {}),
    }),
    onSuccess: (r) => {
      setPreview(r); setErr(null);
      if (r.applied) { setDone(`Issued ${r.issued.filter((x) => x.created).length} new, ${r.issued.filter((x) => !x.created).length} already existed.`); onDone(); }
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <button className="btn-primary" onClick={() => { setOpen(open === 'one' ? null : 'one'); setDone(null); setErr(null); }}><Plus size={16} /> Issue credit</button>
        <button className="btn-ghost" onClick={() => { setOpen(open === 'batch' ? null : 'batch'); setDone(null); setErr(null); setPreview(null); }}>Bulk issue</button>
      </div>
      {open === 'one' && (
        <form className="card p-4 mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); issue.mutate(); }}>
          <div><label className="label">Customer email</label>
            <input className="input w-64" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label className="label">Amount</label>
            <input className="input w-28" inputMode="decimal" placeholder="50.00" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
          <div><label className="label">Code (optional)</label>
            <input className="input w-40" placeholder="Auto-generated" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div className="flex-1 min-w-48"><label className="label">Reason</label>
            <input className="input w-full" required minLength={3} maxLength={255} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
          <button className="btn-primary" disabled={issue.isPending}>{issue.isPending ? <Spinner className="text-white" /> : 'Issue'}</button>
        </form>
      )}
      {open === 'batch' && (
        <div className="card p-4 mb-4 space-y-3">
          <div className="flex flex-wrap gap-3">
            <div><label className="label">Batch name</label>
              <input className="input w-48" placeholder="2026-10-goodwill" value={batch.name} onChange={(e) => { setBatch({ ...batch, name: e.target.value }); setPreview(null); }} /></div>
            <div className="flex-1 min-w-48"><label className="label">Reason</label>
              <input className="input w-full" value={batch.reason} onChange={(e) => setBatch({ ...batch, reason: e.target.value })} /></div>
          </div>
          <div><label className="label">One "email, amount" per line (dollars, max 500)</label>
            <textarea className="input w-full font-mono" rows={6} value={batch.rows} onChange={(e) => { setBatch({ ...batch, rows: e.target.value }); setPreview(null); }} /></div>
          {preview && (
            <div className="text-sm">
              {preview.count} rows, total {money(preview.totalCents)}.
              {preview.errors.map((m) => <div key={m} className="text-red-600">{m}</div>)}
            </div>
          )}
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={runBatch.isPending} onClick={() => runBatch.mutate(false)}>Preview</button>
            <button className="btn-primary" disabled={runBatch.isPending || !preview || preview.errors.length > 0 || preview.applied}
              onClick={() => runBatch.mutate(true)}>Issue {preview ? preview.count : ''} credits</button>
          </div>
          {preview?.applied && (
            <table className="w-full text-sm"><thead><tr><th className="th">Email</th><th className="th">Amount</th><th className="th">Code</th></tr></thead>
              <tbody>{preview.issued.map((r) => <tr key={r.row}><td className="td">{r.email}</td><td className="td">{money(r.amountCents)}</td><td className="td font-mono">{r.code}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
      {err && <div className="mb-4"><ErrorNote message={err} /></div>}
      {done && <div className="mb-4 text-sm text-green-700">{done}</div>}
    </>
  );
}

function ManageModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['account-credit-detail', id], queryFn: () => api.get<Detail>(`/account-credit/${id}`) });
  const [err, setErr] = useState<string | null>(null);
  const [adj, setAdj] = useState({ delta: '', reason: '' });
  const [status, setStatus] = useState({ reason: '' });
  const [res, setRes] = useState({ orderCode: '', lineId: '', quantity: '1', expected: '', reason: '' });
  // One key per form, rotated after success, so a retried submit replays instead of posting twice.
  const [keys, setKeys] = useState({ adj: newKey(), status: newKey(), res: newKey() });
  const after = (k: keyof typeof keys) => () => {
    setKeys((p) => ({ ...p, [k]: newKey() })); setErr(null);
    qc.invalidateQueries({ queryKey: ['account-credit-detail', id] }); onChanged();
  };
  const fail = (e: Error) => setErr(e.message);

  const adjust = useMutation({
    mutationFn: () => {
      const delta = toCents(adj.delta, true);
      if (!delta) return Promise.reject(new Error('Enter a non-zero amount in dollars, e.g. -5.00 or +5.00'));
      return api.post(`/account-credit/${id}/adjust`, { deltaCents: delta, operationKey: keys.adj, reason: adj.reason.trim() });
    },
    onSuccess: () => { setAdj({ delta: '', reason: '' }); after('adj')(); }, onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (disabled: boolean) => api.post(`/account-credit/${id}/status`, { disabled, operationKey: keys.status, reason: status.reason.trim() }),
    onSuccess: () => { setStatus({ reason: '' }); after('status')(); }, onError: fail,
  });
  const restore = useMutation({
    mutationFn: () => {
      const expected = toCents(res.expected);
      if (expected === null) return Promise.reject(new Error('Expected credit must be dollars, e.g. 12.50'));
      return api.post(`/account-credit/${id}/restore`, { orderCode: res.orderCode.trim(), orderLineId: res.lineId, quantity: Number(res.quantity),
        expectedCents: expected, operationKey: keys.res, reason: res.reason.trim() });
    },
    onSuccess: () => { setRes({ orderCode: '', lineId: '', quantity: '1', expected: '', reason: '' }); after('res')(); }, onError: fail,
  });

  const d = detail.data;
  const cur = d?.account.currency ?? 'USD';
  return (
    <Modal open title="Manage account credit" onClose={onClose} width="max-w-3xl">
      {detail.isLoading ? <Loading /> : detail.error ? <ErrorNote message={(detail.error as Error).message} /> : d && (
        <div className="space-y-5">
          <div className="text-sm">
            <div><b>{d.account.email}</b> <span className="font-mono ml-2">{d.account.code}</span> <Badge value={d.account.disabled ? 'draft' : 'active'} label={d.account.disabled ? 'Disabled' : 'Active'} /></div>
            <div className="text-gray-600">Balance {money(d.account.balance, cur)} · held {money(d.account.held, cur)} · available {money(d.account.available, cur)}</div>
          </div>
          {err && <ErrorNote message={err} />}

          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); adjust.mutate(); }}>
            <div><label className="label">Adjust balance</label>
              <input className="input w-28" inputMode="decimal" placeholder="+5.00 / -5.00" required value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value })} /></div>
            <div className="flex-1 min-w-40"><label className="label">Reason</label>
              <input className="input w-full" required minLength={3} maxLength={255} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></div>
            <button className="btn-primary" disabled={adjust.isPending}>Apply</button>
          </form>

          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); toggle.mutate(!d.account.disabled); }}>
            <div className="flex-1 min-w-40"><label className="label">{d.account.disabled ? 'Re-enable' : 'Disable'} this credit — reason</label>
              <input className="input w-full" required minLength={3} maxLength={255} value={status.reason} onChange={(e) => setStatus({ reason: e.target.value })} /></div>
            <button className="btn-primary" disabled={toggle.isPending}>{d.account.disabled ? 'Enable' : 'Disable'}</button>
          </form>

          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); restore.mutate(); }}>
            <div className="label">Manually restore credit for returned units</div>
            {d.redeemedOrders.length === 0 ? <div className="text-sm text-gray-500">This credit has not been redeemed on an order.</div> : (
              <>
                <div className="text-xs text-gray-500">
                  {d.redeemedOrders.map((o) => (
                    <div key={o.orderId}>Order {o.orderCode}: {o.lines.map((l) => `${l.name} ×${l.quantity} [line ${l.id}; credit per unit ${l.unitCreditCents.map((c) => money(c, cur)).join(', ') || 'n/a'}]`).join('; ')}</div>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <input className="input w-32" placeholder="Order code" required value={res.orderCode} onChange={(e) => setRes({ ...res, orderCode: e.target.value })} />
                  <input className="input w-72" placeholder="Order line id" required value={res.lineId} onChange={(e) => setRes({ ...res, lineId: e.target.value })} />
                  <input className="input w-16" type="number" min={1} required value={res.quantity} onChange={(e) => setRes({ ...res, quantity: e.target.value })} />
                  <input className="input w-28" inputMode="decimal" placeholder="Expected $" required value={res.expected} onChange={(e) => setRes({ ...res, expected: e.target.value })} />
                  <input className="input flex-1 min-w-40" placeholder="Reason" required minLength={3} maxLength={255} value={res.reason} onChange={(e) => setRes({ ...res, reason: e.target.value })} />
                  <button className="btn-primary" disabled={restore.isPending}>Restore</button>
                </div>
              </>
            )}
          </form>

          <table className="w-full text-sm">
            <thead><tr><th className="th">When</th><th className="th">Kind</th><th className="th">Status</th><th className="th">Delta</th><th className="th">Balance</th><th className="th">Order</th><th className="th">By / reason</th></tr></thead>
            <tbody>{d.ledger.map((r) => (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="td">{dateTime(r.createdAt)}</td><td className="td">{r.kind}</td><td className="td">{r.status}</td>
                <td className="td">{r.delta ? money(r.delta, cur) : r.kind === 'RESERVE' ? `(${money(r.amount, cur)})` : '—'}</td>
                <td className="td">{r.balanceAfter === null ? '—' : money(r.balanceAfter, cur)}</td>
                <td className="td">{r.orderCode ?? '—'}</td><td className="td text-gray-500">{[r.actor, r.reason].filter(Boolean).join(': ')}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
