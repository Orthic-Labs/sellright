import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api';
import { PageHeader, Spinner, ErrorNote } from '../components/ui';

export default function ProductCreate() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [status, setStatus] = useState('draft');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/products', { name, status, description: description || undefined });
      nav(`/products/${r.id}`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed'); setBusy(false);
    }
  }

  return (
    <>
      <Link to="/products" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Products</Link>
      <PageHeader title="New product" subtitle="Create the product, then add variants on the next screen." />
      {err && <div className="mb-4"><ErrorNote message={err} /></div>}
      <form onSubmit={submit} className="max-w-2xl space-y-5">
        <div className="card p-4 space-y-4">
          <div><label className="label">Title</label><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Anzu Fixed Blade" /></div>
          <div><label className="label">Description</label><textarea className="input min-h-[120px]" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="max-w-xs"><label className="label">Status</label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="draft">Draft</option><option value="active">Active</option>
            </select>
          </div>
        </div>
        <button className="btn-primary" disabled={busy || !name.trim()}>{busy ? <Spinner className="text-white" /> : 'Create product'}</button>
      </form>
    </>
  );
}
