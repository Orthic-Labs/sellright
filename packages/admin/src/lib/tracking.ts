/** Shared types + helpers for the tracking import page and the open-orders grid (server verdicts: api/src/orders/tracking-import.ts). */
export type TrackingStatus =
  | 'ready' | 'update_tracking' | 'unknown_order' | 'missing_tracking' | 'missing_code'
  | 'already_shipped' | 'nothing_to_ship' | 'not_shippable' | 'duplicate_in_file';

export interface PreviewRow {
  index: number; code: string; tracking: string; carrier: string | null; carrierSource: 'given' | 'detected' | 'unknown';
  status: TrackingStatus; message: string; items: { sku: string; name: string; quantity: number }[];
  suggestion?: string; customerEmail?: string | null;
}
/** How an uploaded/pasted file was read (#376). */
export interface ParseInfo {
  titleSkipped: boolean; header: string[] | null;
  columns: { order: string; tracking: string; carrier: string | null };
  skipped: { blank: number; amazon: number; duplicate: number };
  skippedRows: { line: number; code: string; tracking: string; reason: 'blank' | 'amazon' | 'duplicate' }[];
}
export const SKIP_REASON: Record<ParseInfo['skippedRows'][number]['reason'], string> = {
  blank: 'Skipped: no order or tracking number',
  amazon: 'Skipped: Amazon order',
  duplicate: 'Skipped: repeated row',
};
export interface PreviewResponse { rows: PreviewRow[]; summary: { total: number; importable: number; byStatus: Record<string, number> }; parse?: ParseInfo | null }
/** One plain sentence: which columns were used and what was left out. */
export function parseSummary(p: ParseInfo): string {
  const cols = `Order numbers from "${p.columns.order}", tracking from "${p.columns.tracking}"${p.columns.carrier ? `, carrier from "${p.columns.carrier}"` : ', carrier detected from the number'}.`;
  const title = p.titleSkipped ? ' The title line was skipped.' : '';
  const left = [p.skipped.blank && `${p.skipped.blank} without an order or tracking number`, p.skipped.amazon && `${p.skipped.amazon} Amazon order${p.skipped.amazon === 1 ? '' : 's'}`, p.skipped.duplicate && `${p.skipped.duplicate} repeated`].filter(Boolean);
  return `${cols}${title}${left.length ? ` Left out: ${left.join(', ')}.` : ''}`;
}
export interface ImportResponse {
  updated: number; skipped: number; emailsQueued: number; batchId: string;
  errors: { code: string; error: string }[]; rows: (PreviewRow & { imported: boolean })[];
}
export interface RecentImport { id: string; at: string; actor: string | null; source: string; fileName: string | null; total: number; shipped: number; skipped: number; emailsQueued: number; notify: boolean }

export const STATUS_LABEL: Record<TrackingStatus, { label: string; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }> = {
  ready: { label: 'Ready', tone: 'positive' },
  update_tracking: { label: 'Replaces tracking', tone: 'info' },
  unknown_order: { label: 'Unknown order', tone: 'critical' },
  missing_tracking: { label: 'Missing tracking', tone: 'critical' },
  missing_code: { label: 'Missing order', tone: 'critical' },
  already_shipped: { label: 'Already shipped', tone: 'neutral' },
  nothing_to_ship: { label: 'Nothing to ship', tone: 'neutral' },
  not_shippable: { label: 'Cannot ship', tone: 'critical' },
  duplicate_in_file: { label: 'Duplicate order', tone: 'attention' },
};

export const isImportable = (s: TrackingStatus) => s === 'ready' || s === 'update_tracking';
export const itemsSummary = (items: PreviewRow['items']) => items.map((i) => `${i.quantity}× ${i.sku}`).join(', ');

/** Stable key for "what was previewed": any edit afterwards makes the preview stale. */
export const inputKey = (rows: { code: string; tracking: string; carrier?: string | null }[], notify: boolean) =>
  JSON.stringify([notify, rows.map((r) => [r.code.trim().toUpperCase(), r.tracking.replace(/\s+/g, ''), (r.carrier ?? '').trim()])]);
