import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileUp, ListChecks } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { dateTime } from '../lib/format';
import { PageHeader, Spinner, InlineAlert, Badge } from '../components/ui';
import TrackingPreviewTable from '../components/TrackingPreviewTable';
import { TRACKING_TEMPLATE, saveTextFile, toCsv } from '../lib/carrier';
import { STATUS_LABEL, isImportable, type ImportResponse, type PreviewResponse, type PreviewRow, type RecentImport } from '../lib/tracking';

const MAX_FILE_BYTES = 2_000_000;

/** CSV file or pasted text -> server preview (per-row verdicts, nothing written) -> import only the ready rows. */
export default function ImportTracking() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [notify, setNotify] = useState(true);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewedText, setPreviewedText] = useState('');
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // What the user would commit right now: the previewed rows with carrier overrides applied.
  const commitRows = useMemo(() => (preview?.rows ?? []).map((r) => ({ code: r.code, tracking: r.tracking, carrier: overrides[r.index] || (r.carrierSource === 'given' ? r.carrier : null) })), [preview, overrides]);
  // The preview is tied to the exact input it was made from; editing the text afterwards invalidates it.
  const stale = !!preview && text.trim() !== previewedText;
  const importable = preview?.rows.filter((r) => isImportable(r.status)) ?? [];
  const emails = notify ? importable.filter((r) => r.customerEmail).length : 0;

  const recent = useQuery({ queryKey: ['tracking-imports', store?.slug], queryFn: () => api.get<{ items: RecentImport[] }>('/import-tracking/recent') });

  const doPreview = useMutation({
    mutationFn: (body: { csv?: string; rows?: { code: string; tracking: string; carrier?: string | null }[] }) => api.post<PreviewResponse>('/import-tracking/preview', body),
    onSuccess: (r, vars) => {
      setPreview(r); setResult(null); setErr(null);
      setPreviewedText(text.trim());
      if (vars.csv !== undefined) setOverrides({});
    },
    onError: (e) => setErr((e as Error).message),
  });
  const doImport = useMutation({
    mutationFn: () => api.post<ImportResponse>('/import-tracking', { rows: commitRows, notify, source: fileName ? 'csv' : 'paste', fileName: fileName ?? undefined }),
    onSuccess: (r) => { setResult(r); setPreview(null); setErr(null); void qc.invalidateQueries({ queryKey: ['tracking-imports', store?.slug] }); void qc.invalidateQueries({ queryKey: ['orders', store?.slug] }); },
    onError: (e) => setErr((e as Error).message),
  });

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { setErr('That file is larger than 2 MB. Split it into smaller files.'); return; }
    setText(await f.text()); setFileName(f.name); setPreview(null); setResult(null); setErr(null);
  }

  function useSuggestion(index: number, code: string) {
    // Apply the correction to the previewed rows, then re-run the dry run so the verdict is real.
    const rows = commitRows.map((r, i) => (i === index ? { ...r, code } : r));
    doPreview.mutate({ rows });
  }

  function downloadSkipped(rows: (PreviewRow & { imported?: boolean })[]) {
    const skipped = rows.filter((r) => !('imported' in r ? r.imported : isImportable(r.status)));
    saveTextFile('tracking-skipped.csv', toCsv([['order', 'tracking', 'carrier', 'reason'], ...skipped.map((r) => [r.code, r.tracking, r.carrier ?? '', `${STATUS_LABEL[r.status].label}: ${r.message}`])]));
  }

  const byStatus = preview?.summary.byStatus ?? {};
  const skippedCount = preview ? preview.rows.length - importable.length : 0;

  return (
    <>
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Orders</Link>
      <PageHeader title="Import tracking" subtitle="Upload a CSV or paste rows (order, tracking, carrier). You review every row before anything ships." actions={
        <Link to="/orders/tracking-grid" className="btn-ghost whitespace-nowrap"><ListChecks size={15} /> Open orders grid</Link>
      } />
      {err && <div className="mb-4"><InlineAlert tone="critical">{err}</InlineAlert></div>}

      <div className="grid xl:grid-cols-[minmax(0,26rem)_1fr] gap-5 items-start">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" aria-label="Choose a CSV file" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}><FileUp size={15} /> Upload CSV</button>
            <button className="btn-ghost" onClick={() => saveTextFile('tracking-template.csv', TRACKING_TEMPLATE)}><Download size={15} /> Template</button>
            {fileName && <span className="text-xs text-gray-500 truncate max-w-[10rem]" title={fileName}>{fileName}</span>}
          </div>
          <textarea className="input font-mono text-xs min-h-[220px]" aria-label="Tracking rows" placeholder={'order,tracking,carrier\nDD30284,1Z999AA10123456784,UPS\nDD30285,9400111899223817200000'} value={text} onChange={(e) => { setText(e.target.value); setFileName(null); }} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email customers their tracking number</label>
          <button className="btn-primary" disabled={!text.trim() || doPreview.isPending} onClick={() => doPreview.mutate({ csv: text })}>
            {doPreview.isPending ? <Spinner className="text-white" /> : preview ? 'Preview again' : 'Preview import'}
          </button>
          <p className="text-xs text-gray-400">Carrier is detected from the tracking number (UPS, USPS, FedEx) unless you give one. Preview changes nothing.</p>
        </div>

        <div className="space-y-3 min-w-0">
          {preview && (
            <>
              <div className="flex flex-wrap items-center gap-2" aria-live="polite">
                <Badge value="ready" tone="positive" label={`${importable.length} ready`} />
                {Object.entries(byStatus).filter(([s]) => !isImportable(s as PreviewRow['status'])).map(([s, n]) => <Badge key={s} value={s} tone={STATUS_LABEL[s as PreviewRow['status']].tone} label={`${n} ${STATUS_LABEL[s as PreviewRow['status']].label.toLowerCase()}`} />)}
                {skippedCount > 0 && <button className="btn-ghost btn-sm ml-auto" onClick={() => downloadSkipped(preview.rows)}><Download size={13} /> Download {skippedCount} skipped</button>}
              </div>
              <TrackingPreviewTable rows={preview.rows} carrierOverrides={overrides} onCarrier={(i, c) => setOverrides((o) => ({ ...o, [i]: c }))} onUseSuggestion={useSuggestion} disabled={doImport.isPending || doPreview.isPending} />
              {stale && <InlineAlert tone="attention">You changed the input after this preview. Preview again before importing.</InlineAlert>}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-gray-500">{emails > 0 ? `${emails} customer email${emails === 1 ? '' : 's'} will be queued. ` : ''}Only the {importable.length} ready row{importable.length === 1 ? '' : 's'} will be imported; the rest are left untouched.</span>
                <button className="btn-primary whitespace-nowrap" disabled={stale || importable.length === 0 || doImport.isPending} onClick={() => doImport.mutate()}>
                  {doImport.isPending ? <Spinner className="text-white" /> : `Import ${importable.length} ready row${importable.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          )}

          {result && (
            <div className="card p-4 space-y-2" aria-live="polite">
              <div className="text-sm font-medium text-success">{result.updated} order{result.updated === 1 ? '' : 's'} marked shipped. {result.emailsQueued} customer email{result.emailsQueued === 1 ? '' : 's'} queued.</div>
              {result.skipped > 0 && (
                <div className="text-sm text-gray-600">
                  {result.skipped} row{result.skipped === 1 ? '' : 's'} not imported.
                  <button className="btn-ghost btn-sm ml-2" onClick={() => downloadSkipped(result.rows)}><Download size={13} /> Download skipped</button>
                  <ul className="text-xs text-gray-500 mt-1 space-y-0.5">{result.errors.slice(0, 20).map((e, i) => <li key={i}><span className="font-mono">{e.code}</span> — {e.error}</li>)}</ul>
                </div>
              )}
              <button className="btn-ghost btn-sm" onClick={() => { setResult(null); setText(''); setFileName(null); }}>Start another import</button>
            </div>
          )}

          {!preview && !result && <div className="card p-6 text-sm text-gray-400">Preview results appear here: one line per row with its status and the items that will ship.</div>}
        </div>
      </div>

      <section className="mt-8" aria-label="Recent imports">
        <h2 className="text-sm font-semibold mb-2">Recent imports</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: '36rem' }}>
            <thead><tr><th className="th text-left">When</th><th className="th text-left">By</th><th className="th text-left">Source</th><th className="th text-right">Shipped</th><th className="th text-right">Skipped</th><th className="th text-right">Emails queued</th></tr></thead>
            <tbody>
              {recent.data?.items.map((r) => (
                <tr key={r.id}>
                  <td className="td text-gray-500">{dateTime(r.at)}</td><td className="td">{r.actor ?? '—'}</td>
                  <td className="td">{r.fileName ?? (r.source === 'grid' ? 'Open orders grid' : 'Pasted')}</td>
                  <td className="td text-right tnum">{r.shipped}</td><td className="td text-right tnum">{r.skipped}</td><td className="td text-right tnum">{r.notify ? r.emailsQueued : 'off'}</td>
                </tr>
              ))}
              {recent.data?.items.length === 0 && <tr><td className="td text-gray-400" colSpan={6}>No imports yet.</td></tr>}
              {recent.isLoading && <tr><td className="td text-gray-400" colSpan={6}>Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
