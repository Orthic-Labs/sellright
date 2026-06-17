import { describe, expect, it } from 'vitest';
import { halfPeriodDelta, sparkHeights, totals, trendDeltaLabel, type TrendSeries } from './report-deltas.js';

const series = (xs: { day: string; orders: number; revenue: number }[]): TrendSeries => xs;

describe('halfPeriodDelta', () => {
  it('returns null when there are fewer than 4 points', () => {
    expect(halfPeriodDelta(series([{ day: '1', orders: 1, revenue: 10 }, { day: '2', orders: 2, revenue: 20 }]), (p) => p.revenue)).toBeNull();
  });

  it('returns 0 when both halves are zero', () => {
    const s = series([{ day: '1', orders: 0, revenue: 0 }, { day: '2', orders: 0, revenue: 0 }, { day: '3', orders: 0, revenue: 0 }, { day: '4', orders: 0, revenue: 0 }]);
    expect(halfPeriodDelta(s, (p) => p.revenue)).toBe(0);
  });

  it('returns null when previous period is zero and current is positive', () => {
    const s = series([{ day: '1', orders: 0, revenue: 0 }, { day: '2', orders: 0, revenue: 0 }, { day: '3', orders: 1, revenue: 100 }, { day: '4', orders: 2, revenue: 200 }]);
    expect(halfPeriodDelta(s, (p) => p.revenue)).toBeNull();
  });

  it('returns a positive integer percent when revenue doubled in the second half', () => {
    // mid = floor(8/2) = 4 → prev = first 4 days = 4 * 100 = 400, cur = 4 * 200 = 800 → +100%.
    const s = series([
      { day: '1', orders: 1, revenue: 100 }, { day: '2', orders: 1, revenue: 100 },
      { day: '3', orders: 1, revenue: 100 }, { day: '4', orders: 1, revenue: 100 },
      { day: '5', orders: 2, revenue: 200 }, { day: '6', orders: 2, revenue: 200 },
      { day: '7', orders: 2, revenue: 200 }, { day: '8', orders: 2, revenue: 200 },
    ]);
    expect(halfPeriodDelta(s, (p) => p.revenue)).toBe(100);
  });

  it('returns a negative integer percent when revenue halved', () => {
    const s = series([
      { day: '1', orders: 2, revenue: 200 }, { day: '2', orders: 2, revenue: 200 },
      { day: '3', orders: 1, revenue: 100 }, { day: '4', orders: 1, revenue: 100 },
    ]);
    expect(halfPeriodDelta(s, (p) => p.revenue)).toBe(-50);
  });

  it('handles a short, even-length series with all-zero values', () => {
    expect(halfPeriodDelta([], (p) => p.revenue)).toBeNull();
    expect(halfPeriodDelta(series([{ day: '1', orders: 0, revenue: 0 }]), (p) => p.revenue)).toBeNull();
  });
});

describe('totals', () => {
  it('sums revenue and orders', () => {
    expect(totals(series([{ day: '1', orders: 1, revenue: 10 }, { day: '2', orders: 2, revenue: 20 }]))).toEqual({ revenue: 30, orders: 3 });
  });

  it('returns 0/0 for an empty series', () => {
    expect(totals([])).toEqual({ revenue: 0, orders: 0 });
  });
});

describe('trendDeltaLabel', () => {
  it('shows "New" when previous period was zero and current is positive', () => {
    expect(trendDeltaLabel(null, 0, 100).text).toBe('New');
    expect(trendDeltaLabel(null, 0, 100).tone).toBe('positive');
  });

  it('shows "—" when both periods are zero', () => {
    expect(trendDeltaLabel(null, 0, 0).text).toBe('—');
  });

  it('shows a green ▲ + percent when delta is positive', () => {
    expect(trendDeltaLabel(50, 100, 150).text).toBe('▲ 50% vs previous period');
    expect(trendDeltaLabel(50, 100, 150).tone).toBe('positive');
  });

  it('shows a red ▼ + percent when delta is negative', () => {
    expect(trendDeltaLabel(-25, 200, 150).text).toBe('▼ 25% vs previous period');
    expect(trendDeltaLabel(-25, 200, 150).tone).toBe('critical');
  });

  it('shows "—" when delta is exactly 0', () => {
    expect(trendDeltaLabel(0, 100, 100).text).toBe('— vs previous period');
  });
});

describe('sparkHeights', () => {
  it('normalises values into 0..1', () => {
    const s = series([{ day: '1', orders: 0, revenue: 0 }, { day: '2', orders: 0, revenue: 50 }, { day: '3', orders: 0, revenue: 100 }]);
    expect(sparkHeights(s, (p) => p.revenue)).toEqual([0, 0.5, 1]);
  });

  it('returns all-zero when the series is empty', () => {
    expect(sparkHeights([], (p) => p.revenue)).toEqual([]);
  });

  it('clamps negative inputs to 0', () => {
    const s = series([{ day: '1', orders: 0, revenue: -10 }, { day: '2', orders: 0, revenue: 100 }]);
    expect(sparkHeights(s, (p) => p.revenue)).toEqual([0, 1]);
  });
});