// #380: CSV Upload, a 1:1 port of the previous admin's order-tools CsvUploadPage (same flow, controls, order and copy;
// this admin's colours and fonts). The file is parsed server-side (api orders/tracking-import.ts parseTrackingFile).
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { ResultTable } from '../components/FulfilmentResult';
import { dataRowCount, dryRunResult, importResult, type FulfilmentResult } from '../lib/fulfilment';
import { dateTime } from '../lib/format';
import type { ImportResponse, PreviewResponse, RecentImport } from '../lib/tracking';

export default function ImportTracking() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [result, setResult] = useState<FulfilmentResult | null>(null);
  const [isDryRun, setIsDryRun] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Kept from this admin's page (Adrian, 2026-10-26): the list of past imports below the results.
  const recent = useQuery({ queryKey: ['tracking-imports', store?.slug], queryFn: () => api.get<{ items: RecentImport[] }>('/import-tracking/recent') });

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setRowCount(dataRowCount(text));
      setCsv(text);
    };
    reader.onerror = () => setError('Could not read the CSV file.');
    reader.readAsText(file);
  }

  async function run(dryRun: boolean) {
    if (!csv) return;
    setLoading(true);
    setIsDryRun(dryRun);
    setError(null);
    try {
      if (dryRun) {
        setResult(dryRunResult(await api.post<PreviewResponse>('/import-tracking/preview', { csv })));
      } else {
        // Every shipment emails the customer (#380); the server has no opt-out.
        setResult(importResult(await api.post<ImportResponse>('/import-tracking', { csv, source: 'csv', fileName: fileName ?? undefined })));
        void qc.invalidateQueries({ queryKey: ['orders', store?.slug] });
        void qc.invalidateQueries({ queryKey: ['open-orders', store?.slug] });
        void qc.invalidateQueries({ queryKey: ['tracking-imports', store?.slug] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The CSV request failed.');
    } finally {
      setLoading(false);
    }
  }

  async function execute() {
    const ok = await confirm({
      title: 'Confirm Import',
      description: 'This will create fulfillments, transition orders to Shipped, and send customer emails. Run a Dry Run first to preview results.',
      cancelLabel: 'Cancel',
      confirmLabel: 'Confirm Execute',
    });
    if (ok) await run(false);
  }

  return (
    <div className="max-w-[1040px]">
      {dialog}
      <PageHeader title="CSV Upload" subtitle="Upload a VeraCore shipment CSV or any CSV with order code + tracking number columns. Title rows, duplicate lines, and Amazon order IDs are handled automatically." />

      <div className="card p-6 mb-4">
        <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileSelect} className="hidden" aria-label="Choose CSV File" />
        <div className="flex flex-wrap items-center gap-2.5">
          <button className="btn-ghost" onClick={() => fileInputRef.current?.click()}>Choose CSV File</button>
          {fileName && <span className="text-sm text-gray-500">{`${fileName}  (${rowCount} data rows)`}</span>}
        </div>

        {csv !== null && (
          <div>
            <hr className="my-[18px] border-gray-100" />
            <div className="flex flex-wrap items-center gap-2.5">
              <button className="btn-ghost" disabled={loading} onClick={() => void run(true)}>{loading && isDryRun ? 'Running...' : 'Dry Run'}</button>
              <button className="btn-primary" disabled={loading} onClick={() => void execute()}>{loading && !isDryRun ? 'Processing...' : 'Execute Import'}</button>
            </div>
          </div>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-danger font-medium mb-4">{error}</p>}

      {result && <ResultTable result={result} isDryRun={isDryRun} />}

      <section className="mt-8" aria-label="Recent imports">
        <h2 className="text-sm font-semibold mb-2">Recent imports</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: '36rem' }}>
            <thead><tr><th className="th text-left">When</th><th className="th text-left">By</th><th className="th text-left">Source</th><th className="th text-right">Shipped</th><th className="th text-right">Skipped</th><th className="th text-right">Emails sent</th></tr></thead>
            <tbody>
              {recent.data?.items.map((r) => (
                <tr key={r.id}>
                  <td className="td text-gray-500">{dateTime(r.at)}</td><td className="td">{r.actor ?? '—'}</td>
                  <td className="td">{r.fileName ?? (r.source === 'grid' ? 'Manual' : 'Pasted')}</td>
                  <td className="td text-right tnum">{r.shipped}</td><td className="td text-right tnum">{r.skipped}</td><td className="td text-right tnum">{r.emailsQueued}</td>
                </tr>
              ))}
              {recent.data?.items.length === 0 && <tr><td className="td text-gray-400" colSpan={6}>No imports yet.</td></tr>}
              {recent.isLoading && <tr><td className="td text-gray-400" colSpan={6}>Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
