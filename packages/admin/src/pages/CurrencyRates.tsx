import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil } from 'lucide-react';
import { api, auth, ApiError } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner } from '../components/ui';

// ── types ────────────────────────────────────────────────────────────────────

interface CurrencyRate {
  storeId: string;
  currency: string;
  /** Stored as integer × 10000. e.g. rate 1.0834 is stored as 10834. */
  rate: number;
  enabled: boolean;
}

interface FormState {
  currency: string;
  /** Human-readable decimal rate entered by the user, e.g. "1.0834" */
  rate: string;
  enabled: boolean;
}

const RATE_SCALE = 10000;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Convert stored integer rate → human decimal string (10834 → "1.0834") */
function toHuman(stored: number): string {
  return (stored / RATE_SCALE).toFixed(4);
}

/** Convert human decimal string → stored integer (1.0834 → 10834) */
function toStored(human: string): number {
  // Multiply the parsed float by RATE_SCALE and round to nearest integer.
  return Math.round(parseFloat(human) * RATE_SCALE);
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

/** PUT helper — api.ts only exposes get/post/patch/del. We mirror its req()
 *  pattern for the single PUT endpoint needed here. */
async function putJson<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth.store) headers['x-store-slug'] = auth.store;
  const csrf = readCookie('sr_csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`/v1/admin${path}`, {
    method: 'PUT',
    headers,
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (res.status === 401 && location.pathname !== '/login') location.assign('/login');
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

// ── page ─────────────────────────────────────────────────────────────────────

const BLANK_FORM: FormState = { currency: '', rate: '', enabled: true };

export default function CurrencyRatesPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const [editingCurrency, setEditingCurrency] = useState<string | null>(null);

  const key = ['currency-rates', store?.slug];

  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: CurrencyRate[] }>('/currency-rates'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const upsert = useMutation({
    mutationFn: (f: FormState) => {
      const currency = f.currency.trim().toUpperCase();
      // Convert human decimal to the ×10000 integer the API expects.
      const rate = toStored(f.rate);
      return putJson<{ currency: string; rate: number }>(
        `/currency-rates/${currency}`,
        { rate, enabled: f.enabled },
      );
    },
    onSuccess: () => {
      setForm(null);
      setEditingCurrency(null);
      invalidate();
    },
  });

  const openNew = () => {
    setEditingCurrency(null);
    setForm({ ...BLANK_FORM });
  };

  const openEdit = (row: CurrencyRate) => {
    setEditingCurrency(row.currency);
    setForm({ currency: row.currency, rate: toHuman(row.rate), enabled: row.enabled });
  };

  const closeForm = () => {
    setForm(null);
    setEditingCurrency(null);
  };

  const isEditing = editingCurrency !== null;

  return (
    <>
      <PageHeader
        title="Currency Rates"
        subtitle="Presentment rates for multi-currency checkout. Rates are stored as integer × 10000 of the store base currency."
        actions={
          <button className="btn-primary" onClick={form ? closeForm : openNew}>
            <Plus size={16} /> New rate
          </button>
        }
      />

      {form && (
        <form
          className="card p-4 mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            upsert.mutate(form);
          }}
        >
          <div>
            <label className="label">Currency (ISO 4217)</label>
            <input
              className="input w-28 font-mono uppercase"
              maxLength={3}
              value={form.currency}
              disabled={isEditing}
              onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
              placeholder="EUR"
            />
          </div>

          <div>
            <label className="label">Rate vs. base ({store?.currency ?? 'USD'})</label>
            {/* User enters a human decimal (e.g. 1.0834); stored ×10000 as integer */}
            <input
              className="input w-32"
              inputMode="decimal"
              value={form.rate}
              onChange={(e) => setForm({ ...form, rate: e.target.value })}
              placeholder="1.0834"
            />
          </div>

          <div className="flex items-center gap-2 pb-1">
            <input
              id="cr-enabled"
              type="checkbox"
              className="h-4 w-4"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <label htmlFor="cr-enabled" className="label mb-0">Enabled</label>
          </div>

          <button
            className="btn-primary"
            disabled={
              !form.currency.trim() ||
              !form.rate.trim() ||
              isNaN(parseFloat(form.rate)) ||
              upsert.isPending
            }
          >
            {upsert.isPending ? <Spinner className="text-white" /> : isEditing ? 'Update' : 'Create'}
          </button>

          <button type="button" className="btn-ghost" onClick={closeForm}>
            Cancel
          </button>
        </form>
      )}

      {upsert.error && (
        <div className="mb-4">
          <ErrorNote message={(upsert.error as Error).message} />
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorNote message={(error as Error).message} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No currency rates yet" />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Currency</th>
                <th className="th">Rate</th>
                <th className="th">Stored (×10000)</th>
                <th className="th">Status</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={row.currency} className="border-t border-gray-100">
                  <td className="td font-mono font-medium">{row.currency}</td>
                  {/* Human-readable rate = stored integer ÷ 10000 */}
                  <td className="td">{toHuman(row.rate)}</td>
                  <td className="td text-gray-400 text-sm">{row.rate}</td>
                  <td className="td">
                    <Badge value={row.enabled ? 'active' : 'draft'} />
                  </td>
                  <td className="td text-right">
                    <button
                      className="text-gray-400 hover:text-indigo-600"
                      title="Edit"
                      onClick={() => openEdit(row)}
                    >
                      <Pencil size={15} />
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
