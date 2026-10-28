/**
 * #406 product editor. Every field edit (title, description, status, variant price / sale price / stock / active /
 * pre-order) is staged locally and sent only on Save changes. Structure and media (add or delete a variant, options,
 * collections, images, archive) save immediately and say so. The page is full-bleed: Layout skips its padding for /products/:id.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import { api, ApiError, auth, type ProductDetail } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { useLeaveGuard } from '../redesign/leave-guard';
import { ConflictBanner, LoadError, LoadingRows, SaveFailed } from '../redesign/states';
import { AddVariant, type VariantSeed } from '../redesign/product/AddVariant';
import { CollectionsCard } from '../redesign/product/CollectionsCard';
import { MediaCard } from '../redesign/product/MediaCard';
import { OptionsCard, useProductOptions } from '../redesign/product/OptionsCard';
import { VariantTable } from '../redesign/product/VariantTable';
import {
  buildGrid, buildPlan, effective, hasEdit, plural, variantErrors,
  type EditVal, type Edits,
} from '../redesign/product/model';

export default function ProductDetailPage() {
  const { id = '' } = useParams();
  const { store } = useAuth();
  return <ProductDetailEditor key={JSON.stringify([store?.slug, id])} id={id} />;
}

/** updatedAt is returned by GET /products/{id}; api.ts ProductDetail does not declare it yet. */
const stamp = (x: ProductDetail): string | null => (x as ProductDetail & { updatedAt?: string }).updatedAt ?? null;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function ProductDetailEditor({ id }: { id: string }) {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const cur = store?.currency ?? 'USD';
  const currencySymbol = (0).toLocaleString('en-US', { style: 'currency', currency: cur }).replace(/[\d.,\s]/g, '') || '$';
  const key = useMemo(() => ['product', store?.slug, id], [store?.slug, id]);

  const { data: p, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<ProductDetail>(`/products/${id}`) });
  const { data: optData } = useProductOptions(id, store?.slug);

  const [edits, setEditsState] = useState<Edits>({});
  const editsRef = useRef<Edits>({});
  const setEdits = (next: Edits | ((c: Edits) => Edits)) => {
    const v = typeof next === 'function' ? next(editsRef.current) : next;
    editsRef.current = v;
    setEditsState(v);
  };
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [failed, setFailed] = useState<{ count: number; detail: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<VariantSeed | null>(null);

  // updatedAt as the person opened (or last saved) it. Background refetches must not move it, or a conflict would be masked.
  const loadedAt = useRef<string | null>(null);
  useEffect(() => { if (p && loadedAt.current === null) loadedAt.current = stamp(p); }, [p]);

  const active = useRef(true);
  const transportStore = useRef(auth.store).current;
  const isCurrent = () => active.current && auth.store === transportStore;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const rootRef = useRef<HTMLDivElement>(null);

  const eff = useMemo(() => (p ? effective(p, edits) : {}), [p, edits]);
  const count = Object.keys(eff).length;
  useLeaveGuard(count > 0);

  const grid = useMemo(() => (p && optData ? buildGrid(optData.groups, p.variants) : null), [p, optData]);
  const errorsOf = (v: ProductDetail['variants'][number]) => (p ? variantErrors(p, eff, v) : {});
  const badVariants = p ? p.variants.filter((v) => Object.keys(errorsOf(v)).length > 0) : [];
  const titleBad = hasEdit(eff, '_title') && !(eff['_title'] as string).trim();

  const onEdit = (updates: [string, EditVal | undefined][]) => setEdits((c) => {
    const n = { ...c };
    for (const [k, v] of updates) { if (v === undefined) delete n[k]; else n[k] = v; }
    return n;
  });
  const prodVal = (k: '_title' | '_desc' | '_status', base: string) => (hasEdit(edits, k) ? (edits[k] as string) : base);

  const commit = (keys: string[], snap: Edits) => setEdits((c) => {
    const n = { ...c };
    for (const k of keys) if (k in n && sameJson(n[k], snap[k])) delete n[k];
    return n;
  });

  const focusFirstBad = () => setTimeout(() => rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 60);

  async function save() {
    if (savingRef.current || !p) return;
    const latest = qc.getQueryData<ProductDetail>(key) ?? p;
    const snap = effective(latest, editsRef.current);
    const n = Object.keys(snap).length;
    if (!n) return;
    const bad = latest.variants.filter((v) => Object.keys(variantErrors(latest, snap, v)).length > 0);
    const badTitle = hasEdit(snap, '_title') && !(snap['_title'] as string).trim();
    if (bad.length || badTitle) {
      if (grid?.grouped) setExpanded((x) => { const nx = new Set(x); bad.forEach((v) => nx.add(grid.cells.get(v.id)!.a)); return nx; });
      toast.error(bad.length ? `Fix ${plural(bad.length, 'variant')} with errors before saving. Nothing was saved.` : 'Enter a title before saving. Nothing was saved.');
      focusFirstBad();
      return;
    }
    savingRef.current = true;
    setSaving(true); setFailed(null); setConflict(false);
    const plan = buildPlan(latest, snap);
    const remaining = () => Object.keys(effective(latest, editsRef.current)).length;
    try {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const guardIdentity = () => { if (!isCurrent()) throw new Error('Product changed while saving'); };
      if (plan.product) {
        guardIdentity();
        try {
          const r = await api.patch<{ id: string; updatedAt?: string }>(`/products/${id}`, { ...plan.product.body, expectedUpdatedAt: loadedAt.current ?? undefined });
          if (r.updatedAt) loadedAt.current = r.updatedAt;
          commit(plan.product.keys, snap);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) { if (isCurrent()) setConflict(true); return; }
          throw e;
        }
      }
      for (const vp of plan.variants) {
        guardIdentity();
        try {
          if (Object.keys(vp.patch).length) await api.patch(`/variants/${vp.id}`, vp.patch);
          if (vp.onHand !== undefined) await api.patch(`/variants/${vp.id}/stock`, { onHand: vp.onHand });
        } catch (e) { throw new Error(`${vp.sku}: ${(e as Error).message}`); }
        commit(vp.keys, snap);
      }
      guardIdentity();
      const fresh = await api.get<ProductDetail>(`/products/${id}`);
      if (!isCurrent()) { void qc.invalidateQueries({ queryKey: key, refetchType: 'none' }); return; }
      // A read started while the PATCHes were pending would otherwise land after this and restore the old copy.
      await qc.cancelQueries({ queryKey: key, exact: true });
      qc.setQueryData(key, fresh);
      toast.success(`Saved ${plural(n, 'change')} to ${fresh.name}.`);
    } catch (e) {
      void qc.invalidateQueries({ queryKey: key, refetchType: isCurrent() ? 'active' : 'none' });
      if (isCurrent()) setFailed({ count: remaining(), detail: `${(e as Error).message}.`.replace(/\.\.$/, '.') });
    } finally {
      savingRef.current = false;
      if (isCurrent()) setSaving(false);
    }
  }

  const discard = () => {
    const snap = { ...editsRef.current };
    const n = count;
    setEdits({}); setFailed(null); setConflict(false);
    toast.push({ tone: 'info', title: `Discarded ${plural(n, 'change')}.`, ttl: 10000, action: { label: 'Undo', onClick: () => setEdits(snap) } });
  };

  const takeTheirs = async () => {
    setConflictBusy(true);
    try {
      const fresh = await api.get<ProductDetail>(`/products/${id}`);
      qc.setQueryData(key, fresh); loadedAt.current = stamp(fresh);
      setEdits({}); setConflict(false);
    } catch (e) { toast.error("Couldn't load the latest copy", (e as Error).message); }
    finally { setConflictBusy(false); }
  };
  const keepMine = async () => {
    setConflictBusy(true);
    try {
      const fresh = await api.get<ProductDetail>(`/products/${id}`);
      qc.setQueryData(key, fresh); loadedAt.current = stamp(fresh);
      setConflict(false);
    } catch (e) { toast.error("Couldn't load the latest copy", (e as Error).message); setConflictBusy(false); return; }
    setConflictBusy(false);
    await save();
  };

  const deleteVariant = async (v: ProductDetail['variants'][number]) => {
    if (!(await confirm({ title: `Delete variant ${v.sku}?`, description: 'This happens straight away and does not wait for Save changes.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try {
      await api.del(`/variants/${v.id}`);
      setEdits((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith(`${v.id}.`))));
      await qc.invalidateQueries({ queryKey: key });
      toast.success(`Deleted ${v.sku}.`);
    } catch (e) { toast.error('Delete failed', (e as Error).message); }
  };
  const archive = async () => {
    if (!p) return;
    if (!(await confirm({ title: `Archive product "${p.name}"?`, description: 'Its variants will be archived too. Order history is preserved. This happens straight away.', tone: 'danger', confirmLabel: 'Archive' }))) return;
    try {
      await api.del(`/products/${id}`);
      setEdits({});
      toast.success('Product archived');
      nav('/products');
    } catch (e) { toast.error('Archive failed', (e as Error).message); }
  };

  const offer = (aId: string, bId: string) => {
    const a = grid?.first.options.find((o) => o.id === aId);
    const b = grid?.second.options.find((o) => o.id === bId);
    if (a && b) setAdding({ name: `${a.value} / ${b.value}`, optionIds: [aId, bId] });
  };

  if (isLoading) return <div className="rd" aria-busy="true"><div className="savebar"><h1>Loading product…</h1></div><LoadingRows label="Loading product" rows={8} /></div>;
  if (error || !p) return <div className="rd" style={{ padding: 24 }}><LoadError what="this product" detail={(error as Error | null)?.message} onRetry={() => void refetch()} /></div>;

  const title = prodVal('_title', p.name);
  const status = prodVal('_status', p.status);
  const statusHint = status === 'active' ? 'Visible in the store and search.' : 'Hidden from the store. Only staff can see it.';

  return (
    <div className="rd" ref={rootRef} aria-busy={saving}>
      {confirmDialog}
      <div className="savebar">
        <Link to="/products" className="btn ghost sm"><ArrowLeft aria-hidden="true" />Products</Link>
        <h1>{title || p.name}</h1>
        <span className={`pill ${status === 'active' ? 'ok' : 'neu'}`}>{status === 'active' ? 'Active' : 'Draft'}</span>
        <span className="sp" />
        {badVariants.length > 0 && <span className="err" style={{ fontSize: 12.5 }}>{plural(badVariants.length, 'variant')} with errors</span>}
        {count > 0 ? <span className="dirty" role="status">{plural(count, 'unsaved change')}</span> : <span className="muted" style={{ fontSize: 12.5 }} role="status">All changes saved</span>}
        <button type="button" className="btn" disabled={count === 0 || saving} onClick={discard}>Discard</button>
        <button type="button" className="btn pri" disabled={count === 0 || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>

      {(conflict || failed) && (
        <div style={{ padding: '12px 24px 0' }}>
          {conflict
            ? <ConflictBanner busy={conflictBusy} onTheirs={() => void takeTheirs()} onMine={() => void keepMine()}>Someone else saved this product after you opened it.</ConflictBanner>
            : <SaveFailed count={failed!.count} detail={failed!.detail} busy={saving} onRetry={() => void save()} />}
        </div>
      )}

      <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className="grid2" style={{ paddingTop: 16 }}>
          <div className="stack">
            <div className="card">
              <div className="cb-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="fld">
                  <label htmlFor="pt">Title</label>
                  <input id="pt" className={`inp${titleBad ? ' bad' : ''}`} value={title} aria-invalid={titleBad} aria-describedby="pt-e" onChange={(e) => onEdit([['_title', e.target.value]])} />
                  <div className="err" id="pt-e">{titleBad ? 'Enter a title.' : ''}</div>
                </div>
                <div className="fld">
                  <label htmlFor="pdsc">Description</label>
                  <textarea id="pdsc" className="inp" rows={4} value={prodVal('_desc', p.description ?? '')} onChange={(e) => onEdit([['_desc', e.target.value]])} />
                  <span className="hint">Plain text. Shown on the product page.</span>
                </div>
              </div>
            </div>

            <VariantTable
              p={p} edits={eff} grid={grid} currencySymbol={currencySymbol} errorsOf={errorsOf} onEdit={onEdit}
              expanded={expanded} setExpanded={setExpanded} onDelete={(v) => void deleteVariant(v)} onOffer={offer}
              headerExtra={<button type="button" className="btn sm" onClick={() => setAdding({ name: '' })}><Plus aria-hidden="true" />Add variant</button>}
              footer={adding && (
                <AddVariant key={adding.optionIds?.join('|') ?? 'new'} productId={id} storeSlug={store?.slug} ownVariants={p.variants} seed={adding}
                  onDone={() => setAdding(null)} onCancel={() => setAdding(null)} />
              )}
            />

            <OptionsCard productId={p.id} storeSlug={store?.slug} variants={p.variants.map((v) => ({ id: v.id, sku: v.sku, optionIds: v.optionIds }))} />
          </div>

          <div className="stack">
            <div className="card">
              <div className="ch"><h2>Status</h2></div>
              <div className="cb-body">
                <div className="seg" role="radiogroup" aria-label="Product status" style={{ width: '100%', display: 'flex' }}>
                  {([['active', 'Active'], ['draft', 'Draft']] as const).map(([val, label]) => (
                    <button key={val} type="button" role="radio" aria-checked={status === val} tabIndex={status === val ? 0 : -1} style={{ flex: 1 }}
                      onClick={() => onEdit([['_status', val]])}
                      onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); onEdit([['_status', val === 'active' ? 'draft' : 'active']]); } }}>{label}</button>
                  ))}
                </div>
                <div className="hint" style={{ marginTop: 8 }}>{statusHint}{status !== p.status ? ' Takes effect when you save.' : ''}</div>
                <div style={{ marginTop: 12 }}>
                  <button type="button" className="btn dng sm" onClick={() => void archive()}>Archive product…</button>
                  <div className="hint" style={{ marginTop: 6 }}>Hidden and removed from lists. Orders keep it. Archiving happens straight away.</div>
                </div>
              </div>
            </div>

            <MediaCard p={p} storeSlug={store?.slug} getExpected={() => loadedAt.current} onUpdated={(iso) => { loadedAt.current = iso; }} isCurrent={isCurrent} />

            <CollectionsCard productId={p.id} storeSlug={store?.slug} slug={p.slug} />
          </div>
        </div>
      </fieldset>
    </div>
  );
}
