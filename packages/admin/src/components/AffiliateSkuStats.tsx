import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { money } from '../lib/format';
import { RANGE_LABELS, rangeFor, type RangePreset } from '../lib/export-presets';
import { EmptyState, ErrorNote, Field, FormSection, KpiCard, Loading } from './ui';

export interface AffiliateStats {
  range: { from: string | null; to: string | null };
  commissionPct: number;
  totals: { orders: number; units: number; revenue: number; commission: number };
  bySku: { sku: string; name: string; units: number; orders: number; revenue: number; commission: number }[];
}

/** Query string for the stats endpoint; blank dates mean an open end. */
export function statsQuery(from: string, to: string): string {
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const PRESETS: RangePreset[] = ['last7', 'last30', 'last90', 'thisMonth', 'lastMonth', 'thisYear', 'all', 'custom'];

/** Affiliate sales for a date range with a per-SKU breakdown (G8). */
export function AffiliateSkuStats({ affiliateId }: { affiliateId: string }) {
  const { store } = useAuth();
  const cur = store?.currency ?? 'USD';
  const [preset, setPreset] = useState<RangePreset>('last30');
  const [{ from, to }, setRange] = useState(() => rangeFor('last30'));

  const pick = (p: RangePreset) => { setPreset(p); if (p !== 'custom') setRange(rangeFor(p)); };
  const invalid = !!from && !!to && from > to;
  const { data, isLoading, error } = useQuery({
    queryKey: ['affiliate-stats', store?.slug, affiliateId, from, to],
    queryFn: () => api.get<AffiliateStats>(`/affiliates/${affiliateId}/stats${statsQuery(from, to)}`),
    enabled: !invalid,
  });

  return (
    <FormSection title="Sales by product" description={`Paid orders on this affiliate's code, ${data?.commissionPct ?? 10}% commission on the discounted price. Dates are UTC days.`}>
      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <Field label="Date range" htmlFor="aff-range">
          <select id="aff-range" className="input" value={preset} onChange={(e) => pick(e.target.value as RangePreset)}>
            {PRESETS.map((k) => <option key={k} value={k}>{k === 'all' ? 'All time' : RANGE_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="From" htmlFor="aff-from"><input id="aff-from" type="date" className="input" value={from} onChange={(e) => { setPreset('custom'); setRange({ from: e.target.value, to }); }} /></Field>
        <Field label="To" htmlFor="aff-to" error={invalid ? 'From must be on or before To' : undefined}><input id="aff-to" type="date" className="input" value={to} onChange={(e) => { setPreset('custom'); setRange({ from, to: e.target.value }); }} /></Field>
      </div>

      {isLoading && !invalid ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : data && !invalid && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KpiCard label="Orders" value={<span className="tnum">{data.totals.orders}</span>} />
            <KpiCard label="Units" value={<span className="tnum">{data.totals.units}</span>} />
            <KpiCard label="Sales" value={money(data.totals.revenue, cur)} />
            <KpiCard label="Commission" value={money(data.totals.commission, cur)} />
          </div>
          {data.bySku.length === 0 ? <EmptyState title="No sales in this range" hint="Try a longer range." /> : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr><th className="th">SKU</th><th className="th">Product</th><th className="th text-right">Units</th><th className="th text-right">Orders</th><th className="th text-right">Sales</th><th className="th text-right">Commission</th></tr></thead>
                <tbody>
                  {data.bySku.map((r) => (
                    <tr key={r.sku} className="border-t border-gray-100">
                      <td className="td font-mono text-sm">{r.sku}</td><td className="td">{r.name}</td>
                      <td className="td text-right tnum">{r.units}</td><td className="td text-right tnum">{r.orders}</td>
                      <td className="td text-right tnum">{money(r.revenue, cur)}</td><td className="td text-right font-medium tnum">{money(r.commission, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-gray-500">Commission is rounded per product, so the rows can differ from the total by a few cents.</p>
            </div>
          )}
        </>
      )}
    </FormSection>
  );
}
