import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner } from '../components/ui';

interface TaxZone {
  id: string;
  name: string;
  countries: string[];
  // rate is stored as an integer in basis points: 825 = 8.25%
  rate: number;
  priority: number;
  enabled: boolean;
}

interface FormState {
  name: string;
  countries: string; // comma-separated country codes in the UI
  // rate entered by the user as a percent string, e.g. "8.25"
  rate: string;
  priority: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = { name: '', countries: '', rate: '', priority: '0', enabled: true };

/** Display: basis-points integer → "8.25%" */
function bpsToDisplay(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Submit: percent string → basis-points integer (e.g. "8.25" → 825) */
function pctToBps(pct: string): number {
  return Math.round(parseFloat(pct || '0') * 100);
}

export default function TaxZonesPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);

  const key = ['tax-zones', store?.slug];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: TaxZone[] }>('/tax-zones'),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: () => {
      const f = form!;
      const countries = f.countries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      return api.post('/tax-zones', {
        name: f.name.trim(),
        countries,
        // rate: user enters a percent (e.g. "8.25") → stored as basis points (825)
        rate: pctToBps(f.rate),
        priority: parseInt(f.priority || '0', 10),
        enabled: f.enabled,
      });
    },
    onSuccess: () => { setForm(null); invalidate(); },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/tax-zones/${id}`),
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: (z: TaxZone) => api.patch(`/tax-zones/${z.id}`, { enabled: !z.enabled }),
    onSuccess: invalidate,
  });

  return (
    <>
      <PageHeader
        title="Tax Zones"
        subtitle="Country-based tax rates applied at checkout."
        actions={
          <button
            className="btn-primary"
            onClick={() => setForm(form ? null : { ...EMPTY_FORM })}
          >
            <Plus size={16} /> Add zone
          </button>
        }
      />

      {form && (
        <form
          className="card p-4 mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
        >
          <div>
            <label className="label">Name</label>
            <input
              className="input w-40"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="US Standard"
              required
            />
          </div>
          <div>
            <label className="label">Countries (2-letter, comma-separated)</label>
            <input
              className="input w-52"
              value={form.countries}
              onChange={(e) => setForm({ ...form, countries: e.target.value.toUpperCase() })}
              placeholder="US, CA"
              required
            />
          </div>
          <div>
            <label className="label">Rate (%)</label>
            {/* User enters a percent; submitted as basis points (rate × 100) */}
            <input
              className="input w-24"
              inputMode="decimal"
              value={form.rate}
              onChange={(e) => setForm({ ...form, rate: e.target.value })}
              placeholder="8.25"
              required
            />
          </div>
          <div>
            <label className="label">Priority</label>
            <input
              className="input w-20"
              type="number"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              placeholder="0"
            />
          </div>
          <div className="flex items-center gap-2 pb-1">
            <input
              id="tz-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <label htmlFor="tz-enabled" className="label mb-0">Enabled</label>
          </div>
          <button
            className="btn-primary"
            disabled={!form.name.trim() || !form.countries.trim() || create.isPending}
          >
            {create.isPending ? <Spinner className="text-white" /> : 'Create'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setForm(null)}>Cancel</button>
        </form>
      )}
      {create.error && (
        <div className="mb-4"><ErrorNote message={(create.error as Error).message} /></div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? (
          <EmptyState title="No tax zones" />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Countries</th>
                <th className="th">Rate</th>
                <th className="th">Priority</th>
                <th className="th">Status</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((z) => (
                <tr key={z.id} className="border-t border-gray-100">
                  <td className="td font-medium">{z.name}</td>
                  <td className="td font-mono text-sm text-gray-600">{z.countries.join(', ')}</td>
                  {/* rate stored in basis points: divide by 100 to display as percent */}
                  <td className="td tabular-nums">{bpsToDisplay(z.rate)}</td>
                  <td className="td text-gray-500">{z.priority}</td>
                  <td className="td">
                    <button onClick={() => toggle.mutate(z)}>
                      <Badge value={z.enabled ? 'active' : 'draft'} />
                    </button>
                  </td>
                  <td className="td text-right">
                    <button
                      className="text-gray-300 hover:text-danger"
                      onClick={() => {
                        if (confirm(`Delete tax zone "${z.name}"?`)) del.mutate(z.id);
                      }}
                      title="Delete"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
