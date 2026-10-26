/**
 * Fulfilment pages (#380): a 1:1 port of the previous admin's order-tools CSV Upload and Manual Tracking Entry
 * (Damned order-tools dashboard: CsvUploadPage, ManualTrackingPage, shared). These helpers map SellRight's tracking
 * import responses onto that admin's result shape and copy, so the pages read exactly as they did.
 */
import type { ImportResponse, ParseInfo, PreviewResponse, PreviewRow } from './tracking';

export interface ResultDetail { orderCode: string; status: 'success' | 'skipped' | 'error'; message: string; emailSent?: boolean }
export interface FulfilmentResult { success: number; errors: number; skipped: number; emailsSent: number; details: ResultDetail[] }

/** The previous admin's carrier inference (shared.tsx inferProvider): USPS, FedEx, UPS, else ''. */
export function inferProvider(tracking: string): string {
  if (/^(9[24][0-9]{18,20})$/.test(tracking)) return 'USPS';
  if (/^3[0-9]{11}$/.test(tracking) || /^3[0-9]{14}$/.test(tracking)) return 'FedEx';
  if (/^1Z/.test(tracking)) return 'UPS';
  return '';
}

const LEFT_OUT: Record<ParseInfo['skippedRows'][number]['reason'], string> = {
  amazon: 'Amazon order',
  blank: 'No tracking number',
  duplicate: 'Duplicate line',
};

/** One row's line in the previous admin's wording. */
function detail(r: PreviewRow, dryRun: boolean, imported: boolean): ResultDetail {
  const provider = r.carrier || 'Standard Shipping';
  if (r.status === 'ready' || r.status === 'update_tracking') {
    if (dryRun) return { orderCode: r.code, status: 'success', message: `Would ship with ${provider}: ${r.tracking}` };
    if (imported) return { orderCode: r.code, status: 'success', message: `Shipped with ${provider}: ${r.tracking}`, emailSent: !!r.customerEmail };
    return { orderCode: r.code, status: 'error', message: r.message, emailSent: false };
  }
  if (r.status === 'unknown_order') return { orderCode: r.code, status: 'skipped', message: 'Order not found' };
  if (r.status === 'already_shipped' || r.status === 'nothing_to_ship') {
    return { orderCode: r.code, status: 'skipped', message: /deliver/i.test(r.message) ? 'Already Delivered' : 'Already Shipped' };
  }
  if (r.status === 'duplicate_in_file') return { orderCode: r.code, status: 'skipped', message: 'Duplicate line' };
  return { orderCode: r.code || 'N/A', status: 'error', message: r.message };
}

function tally(details: ResultDetail[], emailsSent: number): FulfilmentResult {
  return {
    success: details.filter((d) => d.status === 'success').length,
    errors: details.filter((d) => d.status === 'error').length,
    skipped: details.filter((d) => d.status === 'skipped').length,
    emailsSent, details,
  };
}

const leftOut = (parse: ParseInfo | null | undefined): ResultDetail[] =>
  (parse?.skippedRows ?? []).map((r) => ({ orderCode: r.code || 'N/A', status: 'skipped', message: LEFT_OUT[r.reason] }));

/** Dry Run: the preview's verdicts plus the rows the file parser left out. */
export function dryRunResult(p: PreviewResponse): FulfilmentResult {
  return tally([...p.rows.map((r) => detail(r, true, false)), ...leftOut(p.parse)], 0);
}

/** Execute / Submit: what was imported, plus the rows the file parser left out. */
export function importResult(r: ImportResponse & { parse?: ParseInfo | null }): FulfilmentResult {
  return tally([...r.rows.map((x) => detail(x, false, x.imported)), ...leftOut(r.parse)], r.emailsQueued);
}

/** The previous admin's open-order status label (its virtual display states). */
export function openOrderStatus(o: { state?: string; isPreOrder?: boolean; fulfillmentStatus?: string }): string {
  if (o.fulfillmentStatus === 'partially_fulfilled') return 'Part. Shipped';
  if (o.isPreOrder) return 'Pre-ordered';
  if (o.state === 'PartiallyRefunded') return 'Refunded';
  return 'Processing';
}

/** Data rows as the previous admin counted them: non-empty lines minus one. */
export const dataRowCount = (text: string) => Math.max(0, text.trim().split('\n').filter((l) => l.trim()).length - 1);
