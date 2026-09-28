import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner, Modal, Field } from '../components/ui';
import { money } from '../lib/format';

interface Promo {
  id: string; code: string | null; type: string; value: number; enabled: boolean;
  usedCount: number; usageLimit: number | null; perCustomerUsageLimit: number | null;
  startsAt?: string | null; endsAt?: string | null;
}
interface PromoDetail extends Promo {
  conditions: unknown;
  usage: { orderCode: string; email: string | null; at: string }[];
}
interface ConditionArg { name: string; value: string }
interface Condition { code: string; args?: ConditionArg[] }

/** Reads the repo's existing condition shape (money/coupon.ts evaluateCoupon)
 *  back into simple form fields — no new condition vocabulary invented here,
 *  only surfaced: `minimum_order_amount` (amount cents) and
 *  `at_least_n_with_facets` (facet value id scope + minimum qty), which is
 *  the existing product/collection-scoping primitive on main (facetValueIds
 *  are how products/collections are tagged — see productFacetIds()). */
export function readCondition(conditions: unknown, code: string): Record<string, string> {
  const arr = Array.isArray(conditions) ? (conditions as Condition[]) : [];
  const c = arr.find((x) => x?.code === code);
  const out: Record<string, string> = {};
  for (const a of c?.args ?? []) out[a.name] = a.value;
  return out;
}

export interface FormState {
  id: string | null; // null = create
  code: string; type: string; value: string;
  usageLimit: string; perCustomerUsageLimit: string;
  startsAt: string; endsAt: string;
  minOrderAmount: string;
  facetIds: string; facetMinimum: string;
  enabled: boolean;
}

function emptyForm(): FormState {
  return { id: null, code: '', type: 'percentage', value: '', usageLimit: '', perCustomerUsageLimit: '', startsAt: '', endsAt: '', minOrderAmount: '', facetIds: '', facetMinimum: '1', enabled: true };
}

/** ISO datetime <-> the value a `<input type="datetime-local">` wants (no
 *  timezone suffix, minute precision). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

export function buildConditions(f: FormState): unknown[] | null {
  const conds: Condition[] = [];
  const minAmount = f.minOrderAmount.trim() ? Math.round(parseFloat(f.minOrderAmount) * 100) : 0;
  if (minAmount > 0) conds.push({ code: 'minimum_order_amount', args: [{ name: 'amount', value: String(minAmount) }] });
  const facetIds = f.facetIds.split(',').map((s) => s.trim()).filter(Boolean);
  if (facetIds.length > 0) {
    conds.push({ code: 'at_least_n_with_facets', args: [
      { name: 'facets', value: JSON.stringify(facetIds) },
      { name: 'minimum', value: String(Math.max(1, Number(f.facetMinimum) || 1)) },
    ] });
  }
  return conds.length ? conds : null;
}

export function buildPayload(f: FormState) {
  const isPct = f.type === 'percentage';
  return {
    code: f.code || null,
    type: f.type,
    value: f.type === 'free_shipping' ? 0 : isPct ? Math.round(parseFloat(f.value || '0')) : Math.round(parseFloat(f.value || '0') * 100),
    usageLimit: f.usageLimit ? Number(f.usageLimit) : null,
    perCustomerUsageLimit: f.perCustomerUsageLimit ? Number(f.perCustomerUsageLimit) : null,
    startsAt: fromLocalInput(f.startsAt),
    endsAt: fromLocalInput(f.endsAt),
    conditions: buildConditions(f),
    enabled: f.enabled,
  };
}

export default function Discounts() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const cur = store?.currency ?? 'USD';
  const [form, setForm] = useState<FormState | null>(null);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const closeForm = () => { setForm(null); setHydratedFor(null); };

  const key = ['promotions', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Promo[] }>('/promotions') });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: () => api.post('/promotions', buildPayload(form!)),
    onSuccess: () => { closeForm(); invalidate(); },
  });
  const update = useMutation({
    mutationFn: () => api.patch(`/promotions/${form!.id}`, buildPayload(form!)),
    onSuccess: () => { closeForm(); invalidate(); },
  });
  const toggle = useMutation({ mutationFn: (p: Promo) => api.patch(`/promotions/${p.id}`, { enabled: !p.enabled }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/promotions/${id}`), onSuccess: invalidate });

  const editing = useQuery({
    queryKey: ['promotion', form?.id],
    queryFn: () => api.get<PromoDetail>(`/promotions/${form!.id}`),
    enabled: !!form?.id,
  });
  // Populate the form once the detail loads (edit mode only) — exactly once
  // per opened promotion, tracked by `hydratedFor` so a later re-render (e.g.
  // the user editing a field) never clobbers their in-progress edits.
  useEffect(() => {
    if (!editing.data || !form || form.id !== editing.data.id || hydratedFor === editing.data.id) return;
    const p = editing.data;
    const minCond = readCondition(p.conditions, 'minimum_order_amount');
    const facetCond = readCondition(p.conditions, 'at_least_n_with_facets');
    let facetIds: string[] = [];
    try { facetIds = facetCond.facets ? JSON.parse(facetCond.facets) : []; } catch { /* ignore malformed */ }
    setForm((f) => f && f.id === p.id ? {
      ...f,
      code: p.code ?? '', type: p.type, value: p.type === 'percentage' ? String(p.value) : p.type === 'free_shipping' ? '' : (p.value / 100).toFixed(2),
      usageLimit: p.usageLimit != null ? String(p.usageLimit) : '', perCustomerUsageLimit: p.perCustomerUsageLimit != null ? String(p.perCustomerUsageLimit) : '',
      startsAt: toLocalInput(p.startsAt), endsAt: toLocalInput(p.endsAt),
      minOrderAmount: minCond.amount ? (Number(minCond.amount) / 100).toFixed(2) : '',
      facetIds: facetIds.join(', '), facetMinimum: facetCond.minimum ?? '1',
      enabled: p.enabled,
    } : f);
    setHydratedFor(p.id);
  }, [editing.data, form, hydratedFor]);

  const fmtValue = (p: Promo) => p.type === 'percentage' ? `${p.value}%` : p.type === 'free_shipping' ? 'Free shipping' : money(p.value, cur);
  const fmtWindow = (p: Promo) => {
    if (!p.startsAt && !p.endsAt) return null;
    const d = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString() : '…';
    return `${d(p.startsAt)} – ${d(p.endsAt)}`;
  };

  const saving = create.isPending || update.isPending;
  const isEdit = !!form?.id;

  return (
    <>
      <PageHeader title="Discounts" subtitle="Coupon codes — usage, dates and minimum-order/scope conditions are enforced at checkout." actions={
        <button className="btn-primary" onClick={() => setForm(emptyForm())}><Plus size={16} /> New discount</button>
      } />

      {form && (
        <Modal open title={isEdit ? `Edit discount${form.code ? ` — ${form.code}` : ''}` : 'New discount'} onClose={closeForm} width="max-w-lg">
          {isEdit && editing.isLoading ? <Loading /> : (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); isEdit ? update.mutate() : create.mutate(); }}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Code"><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="SAVE10 (blank = automatic)" /></Field>
                <Field label="Type">
                  <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                    <option value="percentage">Percentage</option><option value="fixed">Fixed amount</option><option value="free_shipping">Free shipping</option>
                  </select>
                </Field>
              </div>
              {form.type !== 'free_shipping' && (
                <Field label={form.type === 'percentage' ? 'Percent' : `Amount (${cur})`}>
                  <input className="input" inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={form.type === 'percentage' ? '10' : '5.00'} />
                </Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Starts at" hint="Optional"><input className="input" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></Field>
                <Field label="Ends at" hint="Optional"><input className="input" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Total usage limit" hint="Blank = unlimited"><input className="input" type="number" min={0} value={form.usageLimit} onChange={(e) => setForm({ ...form, usageLimit: e.target.value })} placeholder="∞" /></Field>
                <Field label="Per-customer limit" hint="Blank = unlimited"><input className="input" type="number" min={0} value={form.perCustomerUsageLimit} onChange={(e) => setForm({ ...form, perCustomerUsageLimit: e.target.value })} placeholder="∞" /></Field>
              </div>
              <Field label={`Minimum order amount (${cur})`} hint="Blank = no minimum">
                <input className="input" inputMode="decimal" value={form.minOrderAmount} onChange={(e) => setForm({ ...form, minOrderAmount: e.target.value })} placeholder="0.00" />
              </Field>
              <Field label="Eligible facet value IDs" hint="Comma-separated. Scopes the discount to products/collections tagged with these facet values — blank applies to the whole order.">
                <input className="input" value={form.facetIds} onChange={(e) => setForm({ ...form, facetIds: e.target.value })} placeholder="e.g. 3f2a…, 9c1b…" />
              </Field>
              {form.facetIds.trim() && (
                <Field label="Minimum matching quantity">
                  <input className="input w-24" type="number" min={1} value={form.facetMinimum} onChange={(e) => setForm({ ...form, facetMinimum: e.target.value })} />
                </Field>
              )}
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
              {(create.error || update.error) && <ErrorNote message={((create.error || update.error) as Error).message} />}
              <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                <button type="button" className="btn-ghost" onClick={closeForm}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={saving || (!isEdit && !form.code.trim() && form.type !== 'percentage' && form.type !== 'fixed' && form.type !== 'free_shipping')}>
                  {saving ? <Spinner className="text-white" /> : isEdit ? 'Save changes' : 'Create'}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? <EmptyState title="No discounts yet" /> : (
          <table className="w-full">
            <thead><tr><th className="th">Code</th><th className="th">Value</th><th className="th">Window</th><th className="th">Used</th><th className="th">Status</th><th className="th"></th></tr></thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="border-t border-gray-100">
                  <td className="td font-mono font-medium">{p.code ?? <span className="text-gray-400 font-sans font-normal">automatic</span>}</td>
                  <td className="td">{fmtValue(p)}</td>
                  <td className="td text-xs text-gray-500">{fmtWindow(p) ?? '—'}</td>
                  <td className="td text-gray-500">{p.usedCount}{p.usageLimit ? ` / ${p.usageLimit}` : ''}{p.perCustomerUsageLimit ? ` · ${p.perCustomerUsageLimit}/cust` : ''}</td>
                  <td className="td"><button onClick={() => toggle.mutate(p)}><Badge value={p.enabled ? 'active' : 'draft'} /></button></td>
                  <td className="td text-right whitespace-nowrap">
                    <button className="text-gray-400 hover:text-ink mr-2" aria-label={`Edit discount ${p.code ?? p.id}`} onClick={() => { setHydratedFor(null); setForm({ ...emptyForm(), id: p.id }); }}><Pencil size={15} /></button>
                    {p.usedCount === 0 && <button className="text-gray-300 hover:text-danger" aria-label={`Delete discount ${p.code ?? p.id}`} onClick={() => del.mutate(p.id)}><Trash2 size={15} /></button>}
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
