// #380: Manual Tracking Entry, a 1:1 port of the previous admin's order-tools ManualTrackingPage (same flow, controls,
// order and copy; this admin's colours and fonts).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { date } from '../lib/format';
import { PageHeader } from '../components/ui';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { ResultTable, StatusBadge } from '../components/FulfilmentResult';
import { dryRunResult, importResult, inferProvider, openOrderStatus, type FulfilmentResult } from '../lib/fulfilment';
import type { ImportResponse, PreviewResponse } from '../lib/tracking';

interface OpenOrderRow { code: string; placedAt: string; isPreOrder: boolean; email: string | null; name: string | null; state?: string; fulfillmentStatus: string }
interface OpenOrder { orderCode: string; customerName: string; orderStatus: string; orderDate: string }

export default function TrackingGrid() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<FulfilmentResult | null>(null);
  const [isDryRun, setIsDryRun] = useState(true);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function loadOrders() {
    setLoading(true); setResult(null); setTracking({}); setError(null);
    try {
      const res = await api.get<{ items: OpenOrderRow[]; total: number }>('/fulfillment/open-orders?limit=2000');
      setOrders(res.items.map((o) => ({ orderCode: o.code, customerName: o.name ?? o.email ?? '', orderStatus: openOrderStatus(o), orderDate: date(o.placedAt) })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load open orders.');
    } finally { setLoading(false); }
  }

  const filledCount = Object.values(tracking).filter((v) => v.trim()).length;

  const buildEntries = () =>
    Object.entries(tracking)
      .filter(([, v]) => v.trim())
      .map(([code, t]) => ({ code, tracking: t.trim(), carrier: inferProvider(t.trim()) || null }));

  async function run(dryRun: boolean) {
    const rows = buildEntries();
    if (!rows.length) return;
    setSubmitting(true); setIsDryRun(dryRun); setError(null);
    try {
      if (dryRun) setResult(dryRunResult(await api.post<PreviewResponse>('/import-tracking/preview', { rows })));
      else {
        setResult(importResult(await api.post<ImportResponse>('/import-tracking', { rows, source: 'grid' })));
        void qc.invalidateQueries({ queryKey: ['orders', store?.slug] });
        void qc.invalidateQueries({ queryKey: ['tracking-imports', store?.slug] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The tracking request failed.');
    } finally { setSubmitting(false); }
  }

  async function submit() {
    const ok = await confirm({
      title: 'Confirm Tracking Update',
      description: `This will ship ${filledCount} order${filledCount !== 1 ? 's' : ''} and send customer shipping notifications. Run Dry Run first to preview.`,
      cancelLabel: 'Cancel',
      confirmLabel: 'Confirm Submit',
    });
    if (ok) await run(false);
  }

  const filtered = orders?.filter((o) =>
    !filter || o.orderCode.toLowerCase().includes(filter.toLowerCase()) || o.customerName.toLowerCase().includes(filter.toLowerCase()),
  ) ?? [];

  return (
    <div className="max-w-[1040px]">
      {dialog}
      <PageHeader title="Manual Tracking Entry" subtitle="Load all open orders, fill in tracking numbers for any or all of them, then submit." />

      {!orders && (
        <div className="card p-6 mb-4">
          <button className="btn-primary" disabled={loading} onClick={() => void loadOrders()}>{loading ? 'Loading orders...' : 'Load Open Orders'}</button>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-danger font-medium mb-4">{error}</p>}

      {orders && (
        <div>
          <div className="card p-6 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-2.5 mb-3.5">
              <span className="text-sm text-gray-500">{`${orders.length} open order${orders.length !== 1 ? 's' : ''} — ${filledCount} tracking number${filledCount !== 1 ? 's' : ''} entered`}</span>
              <div className="flex items-center gap-2">
                <input type="text" className="input py-1.5! text-sm w-[200px]" placeholder="Filter orders..." aria-label="Filter orders" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <button className="btn-ghost" onClick={() => void loadOrders()}>Refresh</button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th text-left">Order</th>
                    <th className="th text-left">Customer</th>
                    <th className="th text-left">Status</th>
                    <th className="th text-left">Date</th>
                    <th className="th text-left">Tracking Number</th>
                    <th className="th text-left w-[60px]">Carrier</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((order) => {
                    const value = tracking[order.orderCode] ?? '';
                    return (
                      <tr key={order.orderCode} className={value.trim() ? 'bg-success-soft' : ''}>
                        <td className="td font-mono text-xs">{order.orderCode}</td>
                        <td className="td">{order.customerName}</td>
                        <td className="td"><StatusBadge state={order.orderStatus} /></td>
                        <td className="td text-xs text-gray-400">{order.orderDate}</td>
                        <td className="td">
                          <input type="text" className="input py-1! text-xs! font-mono w-[200px]" placeholder="Paste tracking number" aria-label={`Tracking number for ${order.orderCode}`}
                            value={value} onChange={(e) => setTracking((prev) => ({ ...prev, [order.orderCode]: e.target.value }))} />
                        </td>
                        <td className="td text-xs text-gray-400">{value.trim() ? inferProvider(value.trim()) || '—' : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {filledCount > 0 && (
            <div className="card p-6 mb-4 bg-surface-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-sm text-gray-700">{`${filledCount} order${filledCount !== 1 ? 's' : ''} ready to update`}</span>
                <button className="btn-ghost" disabled={submitting} onClick={() => void run(true)}>{submitting && isDryRun ? 'Running...' : 'Dry Run'}</button>
                <button className="btn-primary" disabled={submitting} onClick={() => void submit()}>{submitting && !isDryRun ? 'Processing...' : 'Submit'}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {result && <ResultTable result={result} isDryRun={isDryRun} />}
    </div>
  );
}
