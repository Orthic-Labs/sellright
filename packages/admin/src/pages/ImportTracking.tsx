import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api';
import { PageHeader, Spinner, ErrorNote } from '../components/ui';

export default function ImportTracking() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ updated: number; errors: { code: string; error: string }[] } | null>(null);

  function parse(): { code: string; tracking: string; carrier?: string }[] {
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/^code\s*,/i.test(l)) // skip header
      .map((l) => { const [code, tracking, carrier] = l.split(',').map((x) => x.trim()); return { code, tracking, carrier: carrier || undefined }; })
      .filter((r) => r.code && r.tracking);
  }

  async function submit() {
    setErr(null); setResult(null);
    const rows = parse();
    if (!rows.length) { setErr('No valid rows. Format: order_code,tracking,carrier (carrier optional).'); return; }
    setBusy(true);
    try { setResult(await api.post('/import-tracking', { rows })); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Orders</Link>
      <PageHeader title="Import tracking" subtitle="Paste CSV: order_code,tracking,carrier — one per line. Creates Shipped fulfillments; carrier is inferred if blank." />
      {err && <div className="mb-4"><ErrorNote message={err} /></div>}
      <div className="max-w-2xl space-y-4">
        <textarea className="input font-mono text-xs min-h-[220px]" placeholder={'SRAD78C24589,1Z999AA10123456784,UPS\nSR12ACC1E00F,9400111899223817200000'} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? <Spinner className="text-white" /> : `Import ${parse().length} rows`}</button>

        {result && (
          <div className="card p-4">
            <div className="text-sm font-medium text-success">✓ {result.updated} orders marked shipped.</div>
            {result.errors.length > 0 && (
              <div className="mt-2">
                <div className="text-sm font-medium text-danger">{result.errors.length} errors:</div>
                <ul className="text-xs text-gray-600 mt-1 space-y-0.5">{result.errors.map((e, i) => <li key={i}><span className="font-mono">{e.code}</span> — {e.error}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
