// #380: the previous admin's shared ResultTable and StatusBadge (order-tools dashboard shared.tsx), same structure and copy,
// in this admin's styles.
import { Badge, type BadgeTone } from './ui';
import type { FulfilmentResult } from '../lib/fulfilment';

const STATUS_TONE: Record<string, BadgeTone> = {
  Processing: 'positive', 'Pre-ordered': 'info', Refunded: 'critical', Authorized: 'info', 'Part. Shipped': 'info', 'More Payment': 'attention',
};

export function StatusBadge({ state }: { state: string }) {
  return <Badge value={state} tone={STATUS_TONE[state] ?? 'neutral'} label={state} />;
}

const STATUS_CLASS = { success: 'text-success font-medium', skipped: 'text-warning font-medium', error: 'text-danger font-medium' } as const;

/** Shared result table shown after import/dry-run. */
export function ResultTable({ result, isDryRun }: { result: FulfilmentResult; isDryRun: boolean }) {
  return (
    <div className="card p-6 mb-4" aria-live="polite">
      <div className="text-[15px] font-semibold mb-1.5">{isDryRun ? 'Dry Run Preview' : 'Import Results'}</div>
      <div className="flex flex-wrap gap-4 mb-3 text-sm">
        <span>Success: <Badge value="success" tone="positive" label={String(result.success)} /></span>
        <span>Skipped: <Badge value="skipped" tone="neutral" label={String(result.skipped)} /></span>
        <span>Errors: <Badge value="errors" tone={result.errors > 0 ? 'critical' : 'neutral'} label={String(result.errors)} /></span>
        {!isDryRun && <span>Emails sent: <Badge value="emails" tone="neutral" label={String(result.emailsSent)} /></span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="th text-left">Order</th>
              <th className="th text-left">Status</th>
              <th className="th text-left">Message</th>
              {!isDryRun && <th className="th text-left">Email</th>}
            </tr>
          </thead>
          <tbody>
            {result.details.map((d, i) => (
              <tr key={i}>
                <td className="td font-mono text-xs">{d.orderCode}</td>
                <td className={`td ${STATUS_CLASS[d.status]}`}>{d.status}</td>
                <td className="td">{d.message}</td>
                {!isDryRun && <td className="td">{d.emailSent ? 'Yes' : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
