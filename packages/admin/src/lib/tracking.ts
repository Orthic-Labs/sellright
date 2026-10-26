/** Wire types of the tracking import endpoints (server verdicts: api/src/orders/tracking-import.ts). */
export type TrackingStatus =
  | 'ready' | 'update_tracking' | 'unknown_order' | 'missing_tracking' | 'missing_code'
  | 'already_shipped' | 'nothing_to_ship' | 'not_shippable' | 'duplicate_in_file';

export interface PreviewRow {
  index: number; code: string; tracking: string; carrier: string | null; carrierSource: 'given' | 'detected' | 'unknown';
  status: TrackingStatus; message: string; items: { sku: string; name: string; quantity: number }[];
  suggestion?: string; customerEmail?: string | null;
}
/** How an uploaded file was read (#376): title skipped, header, columns used, rows left out and why. */
export interface ParseInfo {
  titleSkipped: boolean; header: string[] | null;
  columns: { order: string; tracking: string; carrier: string | null };
  skipped: { blank: number; amazon: number; duplicate: number };
  skippedRows: { line: number; code: string; tracking: string; reason: 'blank' | 'amazon' | 'duplicate' }[];
}
export interface PreviewResponse { rows: PreviewRow[]; summary: { total: number; importable: number; byStatus: Record<string, number> }; parse?: ParseInfo | null }
export interface ImportResponse {
  parse?: ParseInfo | null;
  updated: number; skipped: number; emailsQueued: number; batchId: string;
  errors: { code: string; error: string }[]; rows: (PreviewRow & { imported: boolean })[];
}
export interface RecentImport { id: string; at: string; actor: string | null; source: string; fileName: string | null; total: number; shipped: number; skipped: number; emailsQueued: number; notify: boolean }
