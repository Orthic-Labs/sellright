/**
 * Report / dashboard period-over-period helpers.
 *
 * The Reports page already had `halfDelta` inlined. This is the same shape,
 * extracted so:
 *   - Dashboard's "vs previous period" tile can share the contract;
 *   - it's unit-testable without rendering React;
 *   - the contract is documented once: previous-period = first half of the
 *     series; current = second half; equal-length windows; null when prev = 0.
 *
 * The dashboard tile currently shows absolute deltas, but it uses the same
 * numeric contract so we wire through the same helper and avoid drift.
 */

export interface TrendPoint {
  /** YYYY-MM-DD or any sortable key. */
  day: string;
  orders: number;
  revenue: number;
}
export type TrendSeries = TrendPoint[];

/**
 * Compare the second half of the series against the first half. Returns:
 *   - null when there are fewer than 4 points (insufficient sample);
 *   - 0 when both halves sum to 0 (no movement either way);
 *   - null when prev == 0 and cur > 0 (cannot express "from zero" as a %).
 *   - otherwise the rounded integer percent change.
 */
export function halfPeriodDelta(series: TrendSeries, pick: (s: TrendPoint) => number): number | null {
  if (!series || series.length < 4) return null;
  const mid = Math.floor(series.length / 2);
  const prev = series.slice(0, mid).reduce((a, s) => a + Number(pick(s)), 0);
  const cur = series.slice(mid).reduce((a, s) => a + Number(pick(s)), 0);
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** Total revenue / orders across the whole series — used by Dashboard tiles. */
export function totals(series: TrendSeries): { revenue: number; orders: number } {
  let r = 0, o = 0;
  for (const p of series) { r += Number(p.revenue) || 0; o += Number(p.orders) || 0; }
  return { revenue: r, orders: o };
}

/** Human-readable label for the "vs previous period" tile — honest, never fabricated. */
export function trendDeltaLabel(delta: number | null, prev: number, cur: number): { tone: 'positive' | 'critical' | 'neutral'; text: string } {
  if (delta == null) {
    if (prev === 0 && cur > 0) return { tone: 'positive', text: 'New' };
    if (prev === 0 && cur === 0) return { tone: 'neutral', text: '—' };
    return { tone: 'neutral', text: '—' };
  }
  if (delta > 0) return { tone: 'positive', text: `▲ ${delta}% vs previous period` };
  if (delta < 0) return { tone: 'critical', text: `▼ ${Math.abs(delta)}% vs previous period` };
  return { tone: 'neutral', text: '— vs previous period' };
}

/** Render a sparkline-friendly array of bar heights (0..1) for the series. */
export function sparkHeights(series: TrendSeries, pick: (s: TrendPoint) => number): number[] {
  const max = Math.max(1, ...series.map((s) => Math.max(0, Number(pick(s)) || 0)));
  return series.map((s) => Math.max(0, Math.min(1, (Number(pick(s)) || 0) / max)));
}