import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, X } from 'lucide-react';
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
interface CollectionRow { id: string; name: string }
interface ProductRow { id: string; name: string }
interface Page<T> { items: T[]; total: number }

export type ScopeKind = '' | 'collections' | 'products' | 'tags';

/** Reads the repo's existing condition shape (money/coupon.ts evaluateCoupon)
 *  back into simple form fields — no new condition vocabulary invented here,
 *  only surfaced: `minimum_order_amount` and the native item-scope conditions
 *  `at_least_n_in_collections` / `at_least_n_products` / `at_least_n_with_tags`,
 *  which match on a product's real collection membership, id, or `tags`. */
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
  scope: ScopeKind;
  scopeMinimum: string;
  collectionIds: string[];
  products: { id: string; name: string }[];
  tags: string[];
  /** Set when a saved discount still carries the retired
   *  `at_least_n_with_facets` condition — shown as a warning in the form and
   *  dropped on save (buildConditions only ever emits native codes). */
  legacyFacetCondition: boolean;
  enabled: boolean;
}

function emptyForm(): FormState {
  return { id: null, code: '', type: 'percentage', value: '', usageLimit: '', perCustomerUsageLimit: '', startsAt: '', endsAt: '', minOrderAmount: '', scope: '', scopeMinimum: '1', collectionIds: [], products: [], tags: [], legacyFacetCondition: false, enabled: true };
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

const parseIds = (raw: string | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
};

/** Maps a saved discount's `conditions` array back into form state — the
 *  inverse of buildConditions(). Product scope ids come back as `{id, name}`
 *  with the id as a placeholder name; the component resolves real names via
 *  `GET /products/{id}` afterwards (no new endpoints). */
export function hydrateForm(p: PromoDetail): FormState {
  const minCond = readCondition(p.conditions, 'minimum_order_amount');
  const colCond = readCondition(p.conditions, 'at_least_n_in_collections');
  const prodCond = readCondition(p.conditions, 'at_least_n_products');
  const tagCond = readCondition(p.conditions, 'at_least_n_with_tags');
  const legacyCond = readCondition(p.conditions, 'at_least_n_with_facets');
  const f = emptyForm();
  return {
    ...f,
    id: p.id,
    code: p.code ?? '', type: p.type, value: p.type === 'percentage' ? String(p.value) : p.type === 'free_shipping' ? '' : (p.value / 100).toFixed(2),
    usageLimit: p.usageLimit != null ? String(p.usageLimit) : '', perCustomerUsageLimit: p.perCustomerUsageLimit != null ? String(p.perCustomerUsageLimit) : '',
    startsAt: toLocalInput(p.startsAt), endsAt: toLocalInput(p.endsAt),
    minOrderAmount: minCond.amount ? (Number(minCond.amount) / 100).toFixed(2) : '',
    scope: colCond.collectionIds ? 'collections' : prodCond.productIds ? 'products' : tagCond.tags ? 'tags' : '',
    scopeMinimum: colCond.minimum ?? prodCond.minimum ?? tagCond.minimum ?? '1',
    collectionIds: parseIds(colCond.collectionIds),
    products: parseIds(prodCond.productIds).map((id) => ({ id, name: id })),
    tags: parseIds(tagCond.tags),
    legacyFacetCondition: Object.keys(legacyCond).length > 0,
    enabled: p.enabled,
  };
}

export function buildConditions(f: FormState): unknown[] | null {
  const conds: Condition[] = [];
  const minAmount = f.minOrderAmount.trim() ? Math.round(parseFloat(f.minOrderAmount) * 100) : 0;
  if (minAmount > 0) conds.push({ code: 'minimum_order_amount', args: [{ name: 'amount', value: String(minAmount) }] });
  // At most one item-scope condition per discount — emitted exactly in the
  // shape money/coupon.ts evaluates (JSON string-array arg + `minimum`).
  const minimum = String(Math.max(1, Number(f.scopeMinimum) || 1));
  if (f.scope === 'collections' && f.collectionIds.length > 0) {
    conds.push({ code: 'at_least_n_in_collections', args: [
      { name: 'collectionIds', value: JSON.stringify(f.collectionIds) },
      { name: 'minimum', value: minimum },
    ] });
  } else if (f.scope === 'products' && f.products.length > 0) {
    conds.push({ code: 'at_least_n_products', args: [
      { name: 'productIds', value: JSON.stringify(f.products.map((p) => p.id)) },
      { name: 'minimum', value: minimum },
    ] });
  } else if (f.scope === 'tags' && f.tags.length > 0) {
    conds.push({ code: 'at_least_n_with_tags', args: [
      { name: 'tags', value: JSON.stringify(f.tags) },
      { name: 'minimum', value: minimum },
    ] });
  }
  return conds.length ? conds : null;
}

/** A chosen scope with nothing selected must not save — buildConditions would
 *  silently emit no scope condition, turning the discount into a whole-order
 *  (store-wide) one. Blocks submit until the merchant picks an item or drops
 *  back to Whole order. */
export function scopeError(f: FormState): string | null {
  if (f.scope === '') return null;
  const empty =
    (f.scope === 'collections' && f.collectionIds.length === 0) ||
    (f.scope === 'products' && f.products.length === 0) ||
    (f.scope === 'tags' && f.tags.length === 0);
  return empty ? 'Select at least one collection, product or tag — or choose Whole order.' : null;
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

const chipCls = 'inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-ink';

export default function Discounts() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const cur = store?.currency ?? 'USD';
  const [form, setForm] = useState<FormState | null>(null);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const closeForm = () => { setForm(null); setHydratedFor(null); setProductQuery(''); setTagDraft(''); };

  // De-Vendure: the API's canonical route is /discounts (/promotions is a
  // deprecated alias — see admin-marketing.ts). This page already called
  // itself "Discounts"; it was only the wire path that still said promotions.
  const key = ['discounts', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Promo[] }>('/discounts') });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: () => api.post('/discounts', buildPayload(form!)),
    onSuccess: () => { closeForm(); invalidate(); },
  });
  const update = useMutation({
    mutationFn: () => api.patch(`/discounts/${form!.id}`, buildPayload(form!)),
    onSuccess: () => { closeForm(); invalidate(); },
  });
  const toggle = useMutation({ mutationFn: (p: Promo) => api.patch(`/discounts/${p.id}`, { enabled: !p.enabled }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/discounts/${id}`), onSuccess: invalidate });

  const editing = useQuery({
    queryKey: ['discount', form?.id],
    queryFn: () => api.get<PromoDetail>(`/discounts/${form!.id}`),
    enabled: !!form?.id,
  });
  // Populate the form once the detail loads (edit mode only) — exactly once
  // per opened discount, tracked by `hydratedFor` so a later re-render (e.g.
  // the user editing a field) never clobbers their in-progress edits.
  useEffect(() => {
    if (!editing.data || !form || form.id !== editing.data.id || hydratedFor === editing.data.id) return;
    const p = editing.data;
    setForm((f) => f && f.id === p.id ? hydrateForm(p) : f);
    setHydratedFor(p.id);
  }, [editing.data, form, hydratedFor]);

  // Scope pickers — existing endpoints only: collections list for the
  // collections scope, products search for the products scope.
  const collections = useQuery({
    queryKey: ['discount-collections', store?.slug],
    queryFn: () => api.get<{ items: CollectionRow[] }>('/collections'),
    enabled: form?.scope === 'collections',
  });
  const productResults = useQuery({
    queryKey: ['discount-products', store?.slug, productQuery],
    queryFn: () => api.get<Page<ProductRow>>(`/products?${new URLSearchParams({ q: productQuery, pageSize: '25' })}`),
    enabled: form?.scope === 'products',
  });
  // Resolve the names of product ids saved on an existing discount so chips
  // render names, not ids.
  useEffect(() => {
    if (!form || form.scope !== 'products') return;
    const unresolved = form.products.filter((p) => p.name === p.id);
    if (unresolved.length === 0) return;
    let cancelled = false;
    (async () => {
      const names = new Map<string, string>();
      await Promise.all(unresolved.map(async (p) => {
        try {
          const d = await api.get<{ name?: string; product?: { name?: string } }>(`/products/${p.id}`);
          const name = d.name ?? d.product?.name;
          if (name) names.set(p.id, name);
        } catch { /* leave the id visible if the product is gone */ }
      }));
      if (cancelled || names.size === 0) return;
      setForm((f) => f ? { ...f, products: f.products.map((p) => names.has(p.id) ? { ...p, name: names.get(p.id)! } : p) } : f);
    })();
    return () => { cancelled = true; };
  }, [form?.id, form?.scope, form?.products]);

  const fmtValue = (p: Promo) => p.type === 'percentage' ? `${p.value}%` : p.type === 'free_shipping' ? 'Free shipping' : money(p.value, cur);
  const fmtWindow = (p: Promo) => {
    if (!p.startsAt && !p.endsAt) return null;
    const d = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString() : '…';
    return `${d(p.startsAt)} – ${d(p.endsAt)}`;
  };

  const addTag = (raw: string) => {
    if (!form) return;
    const t = raw.trim();
    if (t && !form.tags.includes(t)) setForm({ ...form, tags: [...form.tags, t] });
    setTagDraft('');
  };
  const clampScopeMinimum = () => {
    if (form && Number(form.scopeMinimum) < 1) setForm({ ...form, scopeMinimum: '1' });
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
              {form.legacyFacetCondition && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  This discount uses a retired facet condition that no longer applies at checkout — choose a scope and save to replace it.
                </div>
              )}
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
              <Field label="Scope" hint="Restricts which items count toward the discount — whole order applies it to everything.">
                <select className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as ScopeKind })}>
                  <option value="">Whole order</option>
                  <option value="collections">Collections</option>
                  <option value="products">Products</option>
                  <option value="tags">Tags</option>
                </select>
                {scopeError(form) && <p className="mt-1 text-sm text-danger">{scopeError(form)}</p>}
              </Field>
              {form.scope === 'collections' && (
                <Field label="Collections">
                  <div className="space-y-2">
                    {form.collectionIds.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {form.collectionIds.map((id) => (
                          <span key={id} className={chipCls}>
                            {collections.data?.items.find((c) => c.id === id)?.name ?? id}
                            <button type="button" aria-label={`Remove collection ${id}`} onClick={() => setForm({ ...form, collectionIds: form.collectionIds.filter((x) => x !== id) })}><X size={12} /></button>
                          </span>
                        ))}
                      </div>
                    )}
                    <select className="input" value="" onChange={(e) => {
                      const id = e.target.value;
                      if (id && !form.collectionIds.includes(id)) setForm({ ...form, collectionIds: [...form.collectionIds, id] });
                    }}>
                      <option value="">{collections.isLoading ? 'Loading…' : 'Add a collection…'}</option>
                      {(collections.data?.items ?? []).filter((c) => !form.collectionIds.includes(c.id)).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                </Field>
              )}
              {form.scope === 'products' && (
                <Field label="Products" hint="Search by name, then pick.">
                  <div className="space-y-2">
                    {form.products.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {form.products.map((p) => (
                          <span key={p.id} className={chipCls}>
                            {p.name}
                            <button type="button" aria-label={`Remove product ${p.name}`} onClick={() => setForm({ ...form, products: form.products.filter((x) => x.id !== p.id) })}><X size={12} /></button>
                          </span>
                        ))}
                      </div>
                    )}
                    <input className="input" value={productQuery} onChange={(e) => setProductQuery(e.target.value)} placeholder="Search products…" />
                    {(productResults.data?.items ?? []).filter((p) => !form.products.some((x) => x.id === p.id)).slice(0, 8).map((p) => (
                      <button key={p.id} type="button" className="block w-full text-left rounded px-2 py-1 text-sm hover:bg-gray-50"
                        onClick={() => { setForm({ ...form, products: [...form.products, { id: p.id, name: p.name }] }); setProductQuery(''); }}>
                        {p.name}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              {form.scope === 'tags' && (
                <Field label="Tags" hint="Press Enter after each tag name.">
                  <div className="space-y-2">
                    {form.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {form.tags.map((t) => (
                          <span key={t} className={chipCls}>
                            {t}
                            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setForm({ ...form, tags: form.tags.filter((x) => x !== t) })}><X size={12} /></button>
                          </span>
                        ))}
                      </div>
                    )}
                    <input className="input" value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagDraft); } }}
                      onBlur={() => addTag(tagDraft)}
                      placeholder="e.g. summer, clearance" />
                  </div>
                </Field>
              )}
              {form.scope !== '' && (
                <Field label="Minimum matching quantity">
                  <input className="input w-24" type="number" min={1} value={form.scopeMinimum} onChange={(e) => setForm({ ...form, scopeMinimum: e.target.value })} onBlur={clampScopeMinimum} />
                </Field>
              )}
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
              {(create.error || update.error) && <ErrorNote message={((create.error || update.error) as Error).message} />}
              <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                <button type="button" className="btn-ghost" onClick={closeForm}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={saving || !!scopeError(form) || (!isEdit && !form.code.trim() && form.type !== 'percentage' && form.type !== 'fixed' && form.type !== 'free_shipping')}>
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
