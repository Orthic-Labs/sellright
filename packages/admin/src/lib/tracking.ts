/** Shared types + helpers for the tracking import page and the open-orders grid (server verdicts: api/src/orders/tracking-import.ts). */
export type TrackingStatus =
  | 'ready' | 'update_tracking' | 'unknown_order' | 'missing_tracking' | 'missing_code'
  | 'already_shipped' | 'nothing_to_ship' | 'not_shippable' | 'duplicate_in_file';

export interface PreviewRow {
  index: number; code: string; tracking: string; carrier: string | null; carrierSource: 'given' | 'detected' | 'unknown';
  status: TrackingStatus; message: string; items: { sku: string; name: string; quantity: number }[];
  suggestion?: string; customerEmail?: string | null;
}
export interface PreviewResponse { rows: PreviewRow[]; summary: { total: number; importable: number; byStatus: Record<string, number> } }
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
