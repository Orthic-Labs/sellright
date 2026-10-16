import { describe, expect, it } from 'vitest';
import { groupByProduct, sortWaitlist, summarize, waitlistCsv, type VariantDemandRow, type WaitlistReport, type WaitlistRow } from './report.js';

const v = (o: Partial<VariantDemandRow> & Pick<VariantDemandRow, 'key' | 'productKey' | 'productName'>): VariantDemandRow => ({
  productSlug: null, variantName: o.key, sku: o.key.toUpperCase(), available: 0, variants: 1,
  pending: 0, notified: 0, canceled: 0, unconfirmed: 0, legacyClosed: 0, total: 0, lastSignupAt: null, oldestPendingAt: null, ...o,
});

const rows: VariantDemandRow[] = [
  v({ key: 'a1', productKey: 'pa', productName: 'Alpha', pending: 2, total: 3, available: 0, lastSignupAt: '2026-09-02T00:00:00.000Z', oldestPendingAt: '2026-09-01T00:00:00.000Z' }),
  v({ key: 'a2', productKey: 'pa', productName: 'Alpha', pending: 1, notified: 4, total: 5, available: 7, lastSignupAt: '2026-10-01T00:00:00.000Z', oldestPendingAt: '2026-08-01T00:00:00.000Z' }),
  v({ key: 'b1', productKey: 'pb', productName: 'Beta', pending: 5, total: 5, available: null }),
];

describe('waitlist report helpers', () => {
  it('folds variants into one row per product', () => {
    const g = groupByProduct(rows);
    expect(g).toHaveLength(2);
    expect(g.find((r) => r.key === 'pa')).toMatchObject({
      variants: 2, pending: 3, notified: 4, total: 8, available: 7, variantName: null, sku: null,
      lastSignupAt: '2026-10-01T00:00:00.000Z', oldestPendingAt: '2026-08-01T00:00:00.000Z',
    });
    expect(g.find((r) => r.key === 'pb')!.available).toBeNull();
    expect(g.every((r) => !('productKey' in r))).toBe(true);
  });

  it('summarizes across variants', () => {
    expect(summarize(rows)).toMatchObject({ pending: 8, notified: 4, total: 13, variants: 3, products: 2 });
  });

  it('sorts by whitelisted keys, nulls last, ties by total then name', () => {
    const plain = (rs: WaitlistRow[]) => rs.map((r) => r.key);
    const base = rows as WaitlistRow[];
    expect(plain(sortWaitlist(base, 'pending', 'desc'))).toEqual(['b1', 'a1', 'a2']);
    expect(plain(sortWaitlist(base, 'pending', 'asc'))).toEqual(['a2', 'a1', 'b1']);
    expect(plain(sortWaitlist(base, 'available', 'asc'))).toEqual(['a1', 'a2', 'b1']); // null last
    expect(plain(sortWaitlist(base, 'available', 'desc'))).toEqual(['a2', 'a1', 'b1']); // null still last
    expect(plain(sortWaitlist(base, 'oldestPending', 'asc'))).toEqual(['a2', 'a1', 'b1']);
    expect(plain(sortWaitlist(base, 'product', 'desc'))[0]).toBe('b1');
    expect(base.map((r) => r.key)).toEqual(['a1', 'a2', 'b1']); // input untouched
  });

  it('writes CSV with formula and quote escaping', () => {
    const report: WaitlistReport = {
      groupBy: 'variant', range: { from: null, to: null },
      summary: summarize(rows), truncated: false,
      rows: [{ ...rows[0]!, productName: '=SUM(A1)', variantName: 'Say "hi", ok' }],
    };
    const [head, line] = waitlistCsv(report).trim().split('\n');
    expect(head!.startsWith('Product,Variant,SKU,Waiting now')).toBe(true);
    expect(line!.startsWith(`'=SUM(A1),"Say ""hi"", ok",A1,2,`)).toBe(true);
  });
});
