/** Saved column presets for the order export dialog (per browser; localStorage). */
export interface ExportPreset { name: string; columns: string[]; rows: 'order' | 'line' }
const KEY = 'sr_orders_export_presets_v1';

export function loadPresets(): ExportPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.columns) && (p.rows === 'order' || p.rows === 'line')) : [];
  } catch { return []; }
}
export function savePresets(p: ExportPreset[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable: presets just won't persist */ }
}
export function upsertPreset(list: ExportPreset[], next: ExportPreset): ExportPreset[] {
  return [...list.filter((p) => p.name.toLowerCase() !== next.name.toLowerCase()), next];
}

export type RangePreset = 'last7' | 'last30' | 'last90' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'last365' | 'all' | 'custom';
export const RANGE_LABELS: Record<RangePreset, string> = {
  last7: 'Last 7 days', last30: 'Last 30 days', last90: 'Last 90 days', thisMonth: 'This month', lastMonth: 'Last month',
  thisYear: 'This year', last365: 'Last 365 days', all: 'All time', custom: 'Custom range',
};

const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** from/to (UTC days, inclusive) for a preset; blank for "all" and "custom". */
export function rangeFor(preset: RangePreset, now = new Date()): { from: string; to: string } {
  const day = (offset: number) => ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)));
  switch (preset) {
    case 'last7': return { from: day(-6), to: day(0) };
    case 'last30': return { from: day(-29), to: day(0) };
    case 'last90': return { from: day(-89), to: day(0) };
    case 'last365': return { from: day(-364), to: day(0) };
    case 'thisMonth': return { from: ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: day(0) };
    case 'lastMonth': return { from: ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), to: ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))) };
    case 'thisYear': return { from: ymd(new Date(Date.UTC(now.getUTCFullYear(), 0, 1))), to: day(0) };
    default: return { from: '', to: '' };
  }
}
