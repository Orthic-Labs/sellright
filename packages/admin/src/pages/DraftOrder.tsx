import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { api } from '../api';
import { PageHeader, Spinner, ErrorNote } from '../components/ui';

export default function DraftOrder() {
  const nav = useNavigate();
  const [items, setItems] = useState<{ sku: string; quantity: number }[]>([{ sku: '', quantity: 1 }]);
  const [email, setEmail] = useState('');
  const [markPaid, setMarkPaid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setItem = (i: number, patch: Partial<{ sku: string; quantity: number }>) => setItems((a) => a.map((it, idx) => idx === i ? { ...it, ...patch } : it));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const valid = items.filter((i) => i.sku.trim() && i.quantity > 0);
      if (!valid.length) throw new Error('Add at least one item');
      const r = await api.post<{ code: string }>('/draft-orders', { items: valid, email: email || undefined, markPaid });
      nav(`/orders/${r.code}`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed'); setBusy(false);
    }
  }

  return (
    <>
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Orders</Link>
      <PageHeader title="New manual order" subtitle="Phone/in-person order. Enter SKUs and quantities." />
      {err && <div className="mb-4"><ErrorNote message={err} /></div>}
      <form onSubmit={submit} className="max-w-2xl space-y-5">
        <div className="card p-4 space-y-3">
          {items.map((it, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1"><label className="label">SKU</label><input className="input" value={it.sku} onChange={(e) => setItem(i, { sku: e.target.value })} placeholder="variant SKU" /></div>
              <div><label className="label">Qty</label><input className="input w-20" type="number" min={1} value={it.quantity} onChange={(e) => setItem(i, { quantity: Number(e.target.value) })} /></div>
              {items.length > 1 && <button type="button" className="text-gray-300 hover:text-danger pb-2" onClick={() => setItems((a) => a.filter((_, idx) => idx !== i))}><X size={18} /></button>}
            </div>
          ))}
          <button type="button" className="btn-ghost" onClick={() => setItems((a) => [...a, { sku: '', quantity: 1 }])}><Plus size={15} /> Add line</button>
        </div>
        <div className="card p-4 space-y-3">
          <div><label className="label">Customer email (optional)</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={markPaid} onChange={(e) => setMarkPaid(e.target.checked)} /> Mark as paid now (manual payment)</label>
        </div>
        <button className="btn-primary" disabled={busy}>{busy ? <Spinner className="text-white" /> : 'Create order'}</button>
      </form>
    </>
  );
}
