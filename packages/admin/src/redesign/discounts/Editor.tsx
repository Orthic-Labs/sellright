/** #406 discount editor: routes /discounts/new and /discounts/:id. Typed scope, validation, overlap panel, leave guard. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Info, Plus, X } from 'lucide-react';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { useToast } from '../../components/Toast';
import { dateTime, money } from '../../lib/format';
import { confirmLeave, useLeaveGuard } from '../leave-guard';
import { LoadError, LoadingRows } from '../states';
import { ConfirmDlg } from '../payments/Dlg';
import {
  buildPayload, discountStatus, emptyForm, formScope, fromLocalInput, hydrateForm, overlapCandidates, plural, scopeOf, scopesMeet, validateForm,
  windowOf, windowsMeet, type Errors, type FieldKey, type FormState, type Promo, type PromoDetail, type ScopeKind,
} from './model';

interface CollectionRow { id: string; name: string }
interface ProductRow { id: string; name: string }
interface Page<T> { items: T[]; total: number }

const FIELD_ID: Record<FieldKey, string> = {
  code: 'd-code', value: 'd-val', scope: 'd-scope', minOrder: 'd-min', scopeMin: 'd-smin', limit: 'd-lim', perCust: 'd-per', priority: 'd-pri', starts: 'd-st', ends: 'd-en',
};
const ORDER: FieldKey[] = ['code', 'value', 'scope', 'minOrder', 'scopeMin', 'limit', 'perCust', 'priority', 'starts', 'ends'];

function Err({ id, msg }: { id: string; msg?: string }) { return <span className="err" id={id} role="alert">{msg ?? ''}</span>; }
const bad = (m?: string) => (m ? ' bad' : '');

const LIFE: Record<string, (f: FormState) => string> = {
  active: () => 'Live at checkout now.',
  scheduled: (f) => `Not live yet. Starts ${dateTime(fromLocalInput(f.startsAt))}.`,
  expired: (f) => `Not live. Ended ${dateTime(fromLocalInput(f.endsAt))}.`,
  disabled: () => "Turned off. Customers can't use it.",
};

export function DiscountEditor() {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const copyId = search.get('copy');
  const isNew = !id || id === 'new';
  const sourceId = isNew ? copyId : id;
  const { store } = useAuth();
  const slug = store?.slug;
  const cur = store?.currency ?? 'USD';
  const canWrite = store?.role === 'owner' || store?.role === 'manager' || store?.role === 'staff';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState<FormState | null>(isNew && !copyId ? emptyForm() : null);
  const [snap, setSnap] = useState(isNew && !copyId ? JSON.stringify(emptyForm()) : '');
  const [saved, setSaved] = useState(false);
  const [serverErr, setServerErr] = useState('');
  const [codeTaken, setCodeTaken] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [productQuery, setProductQuery] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [usage, setUsage] = useState<PromoDetail['usage']>([]);
  const [used, setUsed] = useState(0);

  const list = useQuery({ queryKey: ['discounts', slug], queryFn: () => api.get<{ items: Promo[] }>('/discounts') });
  const detail = useQuery({
    queryKey: ['discount', slug, sourceId],
    queryFn: () => api.get<PromoDetail>(`/discounts/${sourceId}`),
    enabled: !!sourceId,
    // Always hydrate from a fresh read, never a cached one.
    staleTime: 0, gcTime: 0, refetchOnMount: 'always',
  });

  // Hydrate exactly once per opened discount, so later renders never clobber edits.
  useEffect(() => {
    if (!detail.data || form) return;
    const h = hydrateForm(detail.data);
    const f: FormState = isNew ? { ...h, id: null, code: h.code ? `${h.code}-COPY` : '' } : h;
    setForm(f); setSnap(JSON.stringify(f));
    if (!isNew) { setUsage(detail.data.usage); setUsed(detail.data.usedCount); }
  }, [detail.data, form, isNew]);

  const dirty = !!form && !saved && JSON.stringify(form) !== snap;
  useLeaveGuard(dirty, 'This discount has changes that have not been saved.');

  const collections = useQuery({
    queryKey: ['discount-collections', slug], queryFn: () => api.get<{ items: CollectionRow[] }>('/collections'),
    enabled: !!form && (form.scope === 'collections' || form.collectionIds.length > 0),
  });
  const productResults = useQuery({
    queryKey: ['discount-products', slug, productQuery],
    queryFn: () => api.get<Page<ProductRow>>(`/products?${new URLSearchParams({ q: productQuery, pageSize: '25' })}`),
    enabled: form?.scope === 'products' && productQuery.trim().length > 0,
  });
  // Product ids saved on an existing discount: resolve to names for the chips.
  useEffect(() => {
    if (!form) return;
    const unresolved = form.products.filter((p) => p.name === p.id);
    if (unresolved.length === 0) return;
    let cancelled = false;
    void (async () => {
      const names = new Map<string, string>();
      await Promise.all(unresolved.map(async (p) => {
        try {
          const d = await api.get<{ name?: string; product?: { name?: string } }>(`/products/${p.id}`);
          const name = d.name ?? d.product?.name;
          if (name) names.set(p.id, name);
        } catch { /* leave the id visible if the product is gone */ }
      }));
      if (cancelled || names.size === 0) return;
      // Names are display only: refresh the baseline too so resolving them never reads as an edit.
      const apply = (f: FormState): FormState => ({ ...f, products: f.products.map((p) => names.has(p.id) ? { ...p, name: names.get(p.id)! } : p) });
      setForm((f) => (f ? apply(f) : f));
      setSnap((s) => { try { return JSON.stringify(apply(JSON.parse(s) as FormState)); } catch { return s; } });
    })();
    return () => { cancelled = true; };
  }, [form?.products]); // eslint-disable-line react-hooks/exhaustive-deps

  // Overlap: fetch the other live/scheduled discounts that share dates with this one; compare scopes from their conditions.
  const candidates = useMemo(
    () => (form && list.data ? overlapCandidates(list.data.items, form.id, form).slice(0, 100) : []),
    [form, list.data],
  );
  const others = useQueries({
    queries: candidates.map((c) => ({ queryKey: ['discount-overlap', slug, c.id], queryFn: () => api.get<PromoDetail>(`/discounts/${c.id}`), staleTime: 60_000 })),
  });

  const save = useMutation({
    mutationFn: () => (form!.id ? api.patch(`/discounts/${form!.id}`, buildPayload(form!)) : api.post('/discounts', buildPayload(form!))),
    onSuccess: () => {
      setSaved(true);
      qc.removeQueries({ queryKey: ['discount', slug] });
      void qc.invalidateQueries({ queryKey: ['discounts', slug] });
      void qc.invalidateQueries({ queryKey: ['discount-overlap', slug] });
      toast.success(form!.id ? 'Discount saved' : 'Discount created');
      nav('/discounts');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) { setCodeTaken(form!.code.trim().toLowerCase()); setServerErr(''); return; }
      setServerErr((e as Error).message);
    },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/discounts/${form!.id}`),
    onSuccess: () => { setSaved(true); void qc.invalidateQueries({ queryKey: ['discounts', slug] }); toast.success('Discount deleted'); nav('/discounts'); },
    onError: (e) => { setConfirmDelete(false); toast.error("Couldn't delete", (e as Error).message); },
  });

  const rootRef = useRef<HTMLDivElement>(null);

  if (sourceId && detail.isLoading && !form) return <div className="rd" style={{ flex: 1 }}><div className="ph"><h1>Discount</h1></div><LoadingRows label="Loading discount" rows={5} cols={[120, 0]} /></div>;
  if (!form) {
    return (
      <div className="rd" style={{ flex: 1 }}>
        <div className="ph"><Link className="btn ghost sm" to="/discounts"><ArrowLeft size={14} aria-hidden="true" />Discounts</Link></div>
        <div style={{ padding: '0 24px' }}><LoadError what="this discount" detail={(detail.error as Error | null)?.message ?? 'It may have been deleted.'} onRetry={() => void detail.refetch()} /></div>
      </div>
    );
  }

  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const otherCodes = (list.data?.items ?? []).filter((p) => p.id !== form.id).map((p) => p.code);
  const E: Errors = validateForm(form, used, otherCodes);
  if (codeTaken && form.code.trim().toLowerCase() === codeTaken) E.code = 'A discount with that code already exists';
  const errCount = Object.keys(E).length;
  const isEdit = !!form.id;
  const status = discountStatus({ enabled: form.enabled, startsAt: fromLocalInput(form.startsAt), endsAt: fromLocalInput(form.endsAt) });
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();

  const submit = () => {
    if (errCount) {
      toast.error(`Fix ${plural(errCount, 'field')} first. Nothing was saved.`);
      const first = ORDER.find((k) => E[k]);
      if (first) rootRef.current?.querySelector<HTMLElement>(`#${FIELD_ID[first]}`)?.focus();
      return;
    }
    setServerErr('');
    save.mutate();
  };
  const cancel = () => { void (dirty ? confirmLeave() : Promise.resolve(true)).then((ok) => { if (ok) nav('/discounts'); }); };

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (t && !form.tags.includes(t)) set({ tags: [...form.tags, t] });
    setTagDraft('');
  };
  const scopeNoun = form.scope === 'collections' ? 'collection' : form.scope === 'products' ? 'product' : 'tag';

  // Overlap panel
  const mine = formScope(form);
  const myWindow = windowOf({ startsAt: fromLocalInput(form.startsAt), endsAt: fromLocalInput(form.endsAt) });
  const overlapping = others.flatMap((q) => {
    const d = q.data;
    if (!d) return [];
    if (!windowsMeet(myWindow, windowOf(d)) || !scopesMeet(mine, scopeOf(d.conditions))) return [];
    return [d];
  });
  const overlapLoading = others.some((q) => q.isLoading);
  const group = (form.exclusionGroup ?? '').trim().toLowerCase();
  const sameGroup = group ? overlapping.filter((d) => (d.exclusionGroup ?? '').trim().toLowerCase() === group) : [];
  const alsoApply = overlapping.filter((d) => !sameGroup.includes(d));
  const names = (L: PromoDetail[]) => L.slice(0, 3).map((x) => x.code ?? 'automatic').join(', ') + (L.length > 3 ? ` and ${L.length - 3} more` : '');

  const val = form.type === 'free_shipping' ? 'Free shipping' : form.type === 'percentage' ? `${form.value || '?'}% off` : `${money(Math.round((parseFloat(form.value) || 0) * 100), cur)} off`;
  const scopeText = form.scope === '' ? 'everything'
    : form.scope === 'collections' ? form.collectionIds.map((c) => collections.data?.items.find((x) => x.id === c)?.name ?? c).join(', ') || 'nothing selected'
    : form.scope === 'products' ? form.products.map((p) => p.name).join(', ') || 'nothing selected'
    : form.tags.join(', ') || 'nothing selected';

  const radios: [ScopeKind, string][] = [['', 'Everything'], ['collections', 'Specific collections'], ['products', 'Specific products'], ['tags', 'Specific tags']];

  return (
    <div className="rd" ref={rootRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="savebar">
        <Link className="btn ghost sm" to="/discounts"><ArrowLeft size={14} aria-hidden="true" />Discounts</Link>
        <h1 className="mono" style={{ font: '600 16px var(--mono)' }}>{form.code.trim() || 'New discount'}</h1>
        <span className="sp" />
        {dirty && <span className="dirty" role="status">Unsaved changes</span>}
        {isEdit && used === 0 && canWrite && <button className="btn dng" onClick={() => setConfirmDelete(true)}>Delete…</button>}
        <button className="btn" onClick={cancel}>Cancel</button>
        <button className="btn pri" onClick={submit} disabled={save.isPending || !canWrite}>{save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create discount'}</button>
      </div>
      {serverErr && <div style={{ padding: '12px 24px 0' }}><div className="banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div><b>Couldn't save.</b> {serverErr} Your edits are still here.</div></div></div>}
      {form.legacyFacetCondition && (
        <div style={{ padding: '12px 24px 0' }}><div className="banner w" role="status"><AlertTriangle size={16} aria-hidden="true" /><div>This discount uses a retired facet condition that no longer applies at checkout. Choose a scope and save to replace it.</div></div></div>
      )}

      <div className="grid2" style={{ paddingTop: 16 }}>
        <div className="stack">
          <section className="card"><div className="ch"><h2>Code</h2></div><div className="cb-body">
            <div className="fld">
              <label htmlFor="d-code">Customers type this at checkout. Leave empty for an automatic discount.</label>
              <input id="d-code" className={`inp mono${bad(E.code)}`} value={form.code} style={{ textTransform: 'uppercase' }} autoComplete="off"
                onChange={(e) => set({ code: e.target.value.toUpperCase() })} aria-invalid={!!E.code} aria-describedby="d-code-e" />
              <Err id="d-code-e" msg={E.code} />
              {isEdit && used > 0 && <span className="hint">Used {plural(used, 'time')}. Renaming keeps that history; the old code stops working.</span>}
            </div>
          </div></section>

          <section className="card"><div className="ch"><h2>Value</h2></div>
            <div className="cb-body" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div className="seg" role="radiogroup" aria-label="Discount type">
                {([['percentage', 'Percentage'], ['fixed', 'Fixed amount'], ['free_shipping', 'Free shipping']] as const).map(([t, l]) => (
                  <button key={t} role="radio" aria-checked={form.type === t} tabIndex={form.type === t ? 0 : -1} onClick={() => set({ type: t })}>{l}</button>
                ))}
              </div>
              {form.type !== 'free_shipping' && (
                <>
                  <div className="fld" style={{ width: 140 }}>
                    <div className="fx">
                      {form.type === 'fixed' && <i>$</i>}
                      <input id="d-val" className={`inp${form.type === 'fixed' ? ' money' : ''}${bad(E.value)}`} value={form.value} inputMode="decimal" aria-label="Discount value"
                        onChange={(e) => set({ value: e.target.value })} aria-invalid={!!E.value} aria-describedby="d-val-e" />
                    </div>
                    <Err id="d-val-e" msg={E.value} />
                  </div>
                  {form.type === 'percentage' && <span className="muted" style={{ height: 30, display: 'flex', alignItems: 'center' }}>% off</span>}
                </>
              )}
            </div>
          </section>

          <section className="card"><div className="ch"><h2>Applies to</h2></div><div className="cb-body">
            {/* The three lists live side by side in the form, so a radio round trip never drops a selection. */}
            <div className="radios" role="radiogroup" aria-label="Applies to" aria-describedby="d-scope-e">
              {radios.map(([k, l]) => (
                <label key={k || 'all'}><input type="radio" name="d-app" checked={form.scope === k} onChange={() => set({ scope: k })} />{l}</label>
              ))}
            </div>
            {form.scope === 'collections' && (
              <div style={{ marginTop: 10, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {form.collectionIds.map((c) => {
                    const name = collections.data?.items.find((x) => x.id === c)?.name ?? c;
                    return <span key={c} className="tag">{name}<button className="iconbtn" style={{ width: 18, height: 18 }} aria-label={`Remove ${name}`} onClick={() => set({ collectionIds: form.collectionIds.filter((x) => x !== c) })}><X size={11} aria-hidden="true" /></button></span>;
                  })}
                </div>
                <select id="d-scope" className="inp sel" style={{ maxWidth: 280 }} value="" aria-label="Add a collection"
                  onChange={(e) => { const v = e.target.value; if (v && !form.collectionIds.includes(v)) set({ collectionIds: [...form.collectionIds, v] }); }}>
                  <option value="">{collections.isLoading ? 'Loading…' : 'Add a collection…'}</option>
                  {(collections.data?.items ?? []).filter((c) => !form.collectionIds.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            {form.scope === 'products' && (
              <div style={{ marginTop: 10, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {form.products.map((p) => (
                    <span key={p.id} className="tag">{p.name}<button className="iconbtn" style={{ width: 18, height: 18 }} aria-label={`Remove ${p.name}`} onClick={() => set({ products: form.products.filter((x) => x.id !== p.id) })}><X size={11} aria-hidden="true" /></button></span>
                  ))}
                </div>
                <input id="d-scope" className="inp" style={{ maxWidth: 280 }} value={productQuery} onChange={(e) => setProductQuery(e.target.value)} placeholder="Search products by name" aria-label="Search products" />
                {(productResults.data?.items ?? []).filter((p) => !form.products.some((x) => x.id === p.id)).slice(0, 8).map((p) => (
                  <button key={p.id} className="btn ghost sm" style={{ justifyContent: 'flex-start', maxWidth: 280 }}
                    onClick={() => { set({ products: [...form.products, { id: p.id, name: p.name }] }); setProductQuery(''); }}><Plus size={12} aria-hidden="true" />{p.name}</button>
                ))}
              </div>
            )}
            {form.scope === 'tags' && (
              <div style={{ marginTop: 10, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {form.tags.map((t) => (
                    <span key={t} className="tag">{t}<button className="iconbtn" style={{ width: 18, height: 18 }} aria-label={`Remove ${t}`} onClick={() => set({ tags: form.tags.filter((x) => x !== t) })}><X size={11} aria-hidden="true" /></button></span>
                  ))}
                </div>
                <input id="d-scope" className="inp" style={{ maxWidth: 280 }} value={tagDraft} placeholder="Type a tag, press Enter" aria-label="Add a tag"
                  onChange={(e) => setTagDraft(e.target.value)} onBlur={() => addTag(tagDraft)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagDraft); } }} />
              </div>
            )}
            <div className="err" id="d-scope-e" role="alert" style={{ paddingLeft: 22, marginTop: 4 }}>{E.scope ?? ''}</div>
            {form.scope !== '' && (
              <div className="fld" style={{ marginTop: 10, paddingLeft: 22, maxWidth: 200 }}>
                <label htmlFor="d-smin">Matching {scopeNoun}s needed in the order</label>
                <input id="d-smin" className={`inp${bad(E.scopeMin)}`} value={form.scopeMinimum} inputMode="numeric" onChange={(e) => set({ scopeMinimum: e.target.value })} aria-invalid={!!E.scopeMin} aria-describedby="d-smin-e" />
                <Err id="d-smin-e" msg={E.scopeMin} />
              </div>
            )}
          </div></section>

          <section className="card"><div className="ch"><h2>Requirements and limits</h2></div>
            <div className="cb-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
              <div className="fld">
                <label htmlFor="d-min">Minimum order amount</label>
                <div className="fx"><i>$</i><input id="d-min" className={`inp money${bad(E.minOrder)}`} value={form.minOrderAmount} inputMode="decimal" placeholder="No minimum" onChange={(e) => set({ minOrderAmount: e.target.value })} aria-invalid={!!E.minOrder} aria-describedby="d-min-e" /></div>
                <Err id="d-min-e" msg={E.minOrder} />
              </div>
              <div className="fld">
                <label htmlFor="d-lim">Total uses</label>
                <input id="d-lim" className={`inp${bad(E.limit)}`} value={form.usageLimit} placeholder="Unlimited" inputMode="numeric" onChange={(e) => set({ usageLimit: e.target.value })} aria-invalid={!!E.limit} aria-describedby="d-lim-e" />
                <Err id="d-lim-e" msg={E.limit} />
              </div>
              <div className="fld">
                <label htmlFor="d-per">Uses per customer</label>
                <input id="d-per" className={`inp${bad(E.perCust)}`} value={form.perCustomerUsageLimit} placeholder="Unlimited" inputMode="numeric" onChange={(e) => set({ perCustomerUsageLimit: e.target.value })} aria-invalid={!!E.perCust} aria-describedby="d-per-e" />
                <Err id="d-per-e" msg={E.perCust} />
              </div>
            </div>
          </section>

          <section className="card"><div className="ch"><h2>Combining with other discounts</h2></div>
            <div className="cb-body" style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 12, alignItems: 'start' }}>
              <div className="fld">
                <label htmlFor="d-grp">Exclusion group</label>
                <input id="d-grp" className="inp" value={form.exclusionGroup ?? ''} placeholder={form.exclusionGroup === undefined ? 'Unchanged' : 'None'} onChange={(e) => set({ exclusionGroup: e.target.value })} />
                <span className="hint">Codes in the same group don't stack. The higher priority wins.</span>
              </div>
              <div className="fld">
                <label htmlFor="d-pri">Priority</label>
                <input id="d-pri" className={`inp${bad(E.priority)}`} value={form.priority ?? ''} placeholder={form.priority === undefined ? 'Unchanged' : '0'} inputMode="numeric" onChange={(e) => set({ priority: e.target.value })} aria-invalid={!!E.priority} aria-describedby="d-pri-e" />
                <Err id="d-pri-e" msg={E.priority} />
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 8 }} aria-live="polite">
                {overlapLoading && <span className="hint">Checking other discounts for overlap…</span>}
                {sameGroup.length > 0 && <div className="note"><Info size={14} aria-hidden="true" /><span>Won't stack with <b>{names(sameGroup)}</b> (same group, {form.exclusionGroup}). Only one of these applies per order; the higher priority wins.</span></div>}
                {alsoApply.length > 0 && <div className="note w"><AlertTriangle size={14} aria-hidden="true" /><span>Also applies to the same {form.scope === '' ? 'items' : form.scope === 'collections' ? 'collections' : form.scope === 'products' ? 'products' : 'tags'} as <b>{names(alsoApply)}</b>, and their dates overlap. Put them in one exclusion group if they shouldn't combine.</span></div>}
              </div>
            </div>
          </section>

          <section className="card"><div className="ch"><h2>Active dates</h2><span className="hint">{tz ? `Your browser's time zone (${tz})` : "Your browser's time zone"}</span></div>
            <div className="cb-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
              <div className="fld">
                <label htmlFor="d-st">Starts</label>
                <input id="d-st" type="datetime-local" className={`inp${bad(E.starts)}`} value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} aria-invalid={!!E.starts} aria-describedby="d-st-e" />
                <Err id="d-st-e" msg={E.starts} /><span className="hint">Empty starts right away.</span>
              </div>
              <div className="fld">
                <label htmlFor="d-en">Ends</label>
                <input id="d-en" type="datetime-local" className={`inp${bad(E.ends)}`} value={form.endsAt} onChange={(e) => set({ endsAt: e.target.value })} aria-invalid={!!E.ends} aria-describedby="d-en-e" />
                <Err id="d-en-e" msg={E.ends} /><span className="hint">Empty never ends.</span>
              </div>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card"><div className="ch"><h2>Summary</h2></div><div className="cb-body">
            <ul style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <li>{val} {scopeText}</li>
              <li>{form.minOrderAmount.trim() ? `Minimum order ${form.minOrderAmount}` : 'No minimum'}</li>
              <li>{form.usageLimit.trim() ? `${form.usageLimit} uses in total` : 'Unlimited uses'}</li>
              <li>{form.perCustomerUsageLimit.trim() ? `${plural(Number(form.perCustomerUsageLimit) || 0, 'use')} per customer` : 'No per-customer limit'}</li>
              <li>{form.startsAt ? `From ${dateTime(fromLocalInput(form.startsAt))}` : 'Starts right away'}{form.endsAt ? ` to ${dateTime(fromLocalInput(form.endsAt))}` : ', no end date'}</li>
            </ul>
          </div></section>

          <section className="card"><div className="ch"><h2>Status</h2></div><div className="cb-body">
            <div className="seg" role="radiogroup" aria-label="Discount status" style={{ display: 'flex' }}>
              {([[true, 'Active'], [false, 'Disabled']] as const).map(([v, l]) => (
                <button key={l} role="radio" style={{ flex: 1 }} aria-checked={form.enabled === v} tabIndex={form.enabled === v ? 0 : -1} onClick={() => set({ enabled: v })}>{l}</button>
              ))}
            </div>
            <div className="hint" style={{ marginTop: 8 }} role="status">{LIFE[status]!(form)}</div>
          </div></section>

          {isEdit && (
            <section className="card"><div className="ch"><h2>Usage</h2></div><div className="cb-body">
              <div className="kv"><span>{used} used</span><span className="muted">{form.usageLimit.trim() ? `of ${form.usageLimit}` : 'no limit'}</span></div>
              {form.usageLimit.trim() && Number(form.usageLimit) > 0 && <div className="bar" style={{ marginTop: 6 }}><span style={{ width: `${Math.min(100, (used / Number(form.usageLimit)) * 100)}%` }} /></div>}
              {usage.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="lbl">Recent orders</div>
                  {usage.slice(0, 8).map((u) => <div className="kv" key={`${u.orderCode}-${u.at}`}><Link className="lnk mono" to={`/orders/${u.orderCode}`}>{u.orderCode}</Link><span className="muted">{dateTime(u.at)}</span></div>)}
                </div>
              )}
            </div></section>
          )}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDlg open title={`Delete ${form.code.trim() || 'this discount'}?`} confirmLabel="Delete discount" danger busy={del.isPending}
          onClose={() => setConfirmDelete(false)} onConfirm={() => del.mutate()}>
          <p>This removes the discount for good. It has never been used, so no orders are affected. This can't be undone.</p>
        </ConfirmDlg>
      )}
    </div>
  );
}
