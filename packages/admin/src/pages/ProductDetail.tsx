import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Package, Trash2, Plus, X, Upload } from 'lucide-react';
import { api, assetUrl, uploadAsset, type ProductDetail, type VariantRow } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { PageHeader, StatusBadge, FormSection, InlineAlert, ErrorState, Loading, Field, Spinner } from '../components/ui';

type Draft = { name: string; status: string; description: string; variants: Record<string, { price: string; salePrice: string; enabled: boolean; onHand: string }> };

function toDraft(p: ProductDetail): Draft {
  return {
    name: p.name, status: p.status, description: p.description ?? '',
    variants: Object.fromEntries(p.variants.map((v) => [v.id, {
      price: (v.price / 100).toFixed(2), salePrice: v.salePrice != null ? (v.salePrice / 100).toFixed(2) : '',
      enabled: v.enabled, onHand: String(v.onHand),
    }])),
  };
}
const toCents = (s: string) => Math.round(parseFloat(s) * 100);

export default function ProductDetailPage() {
  const { id = '' } = useParams();
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cur = store?.currency ?? 'USD';

  const { data: p, isLoading, error } = useQuery({
    queryKey: ['product', store?.slug, id],
    queryFn: () => api.get<ProductDetail>(`/products/${id}`),
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (p) setDraft(toDraft(p)); }, [p]);

  const save = useMutation({
    mutationFn: async () => {
      if (!p || !draft) return;
      if (draft.name !== p.name || draft.status !== p.status || (draft.description ?? '') !== (p.description ?? '')) {
        await api.patch(`/products/${p.id}`, { name: draft.name, status: draft.status, description: draft.description });
      }
      for (const v of p.variants) {
        const d = draft.variants[v.id]!;
        const price = toCents(d.price);
        const salePrice = d.salePrice.trim() === '' ? null : toCents(d.salePrice);
        const onHand = Number(d.onHand);
        // Guard bad input so we never PATCH NaN (which serializes to null / 422).
        if (Number.isNaN(price) || (salePrice !== null && Number.isNaN(salePrice)) || !Number.isInteger(onHand) || onHand < 0) {
          throw new Error(`Invalid price or stock for variant ${v.sku}`);
        }
        const vp: Record<string, unknown> = {};
        if (price !== v.price) vp.price = price;
        if (salePrice !== v.salePrice) vp.salePrice = salePrice;
        if (d.enabled !== v.enabled) vp.enabled = d.enabled;
        if (Object.keys(vp).length) await api.patch(`/variants/${v.id}`, vp);
        if (onHand !== v.onHand) await api.patch(`/variants/${v.id}/stock`, { onHand });
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['product', store?.slug, id] }); toast.success('Product saved'); },
    onError: (e) => toast.error('Save failed', (e as Error).message),
  });

  const nav = useNavigate();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['product', store?.slug, id] });
  const del = useMutation({ mutationFn: () => api.del(`/products/${id}`), onSuccess: () => { toast.success('Product archived'); nav('/products'); }, onError: (e) => toast.error('Archive failed', (e as Error).message) });
  const delVariant = useMutation({ mutationFn: (vid: string) => api.del(`/variants/${vid}`), onSuccess: () => { invalidate(); toast.success('Variant deleted'); }, onError: (e) => toast.error('Delete failed', (e as Error).message) });
  const [nv, setNv] = useState<{ sku: string; name: string; price: string; onHand: string } | null>(null);
  const addVariant = useMutation({
    mutationFn: async () => {
      if (!nv) return;
      const price = toCents(nv.price); const onHand = Number(nv.onHand || '0');
      if (!nv.sku.trim() || !nv.name.trim() || Number.isNaN(price) || !Number.isInteger(onHand) || onHand < 0) throw new Error('SKU, name, valid price and stock required');
      await api.post(`/products/${id}/variants`, { sku: nv.sku, name: nv.name, price, onHand });
    },
    onSuccess: () => { setNv(null); invalidate(); toast.success('Variant added'); },
    onError: (e) => toast.error('Add variant failed', (e as Error).message),
  });

  // WP8c: featured-image upload — upload the file, then set it as the product's
  // featured asset. The API re-encodes to webp + validates magic bytes server-side.
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  async function onPickImage(file: File) {
    setUploadErr(null); setUploading(true);
    try {
      const asset = await uploadAsset(file);
      await api.patch(`/products/${id}`, { featuredAssetId: asset.id });
      invalidate();
      toast.success('Featured image updated');
    } catch (e) { setUploadErr((e as Error).message); }
    finally { setUploading(false); }
  }
  const removeImage = useMutation({ mutationFn: () => api.patch(`/products/${id}`, { featuredAssetId: null }), onSuccess: () => { invalidate(); toast.success('Featured image removed'); }, onError: (e) => toast.error('Remove failed', (e as Error).message) });
  // WP8c gallery (product_asset): upload → attach, remove, promote-to-featured.
  async function addToGallery(file: File) {
    setUploadErr(null); setUploading(true);
    try { const a = await uploadAsset(file); await api.post(`/products/${id}/assets`, { assetId: a.id }); invalidate(); toast.success('Added to gallery'); }
    catch (e) { setUploadErr((e as Error).message); } finally { setUploading(false); }
  }
  const removeFromGallery = useMutation({ mutationFn: (assetId: string) => api.del(`/products/${id}/assets/${assetId}`), onSuccess: () => { invalidate(); toast.success('Removed from gallery'); }, onError: (e) => toast.error('Remove failed', (e as Error).message) });
  const setFeatured = useMutation({ mutationFn: (assetId: string) => api.patch(`/products/${id}`, { featuredAssetId: assetId }), onSuccess: () => { invalidate(); toast.success('Featured image updated'); }, onError: (e) => toast.error('Update failed', (e as Error).message) });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState title="Couldn't load this product" message={(error as Error).message} onRetry={invalidate} />;
  if (!p || !draft) return null;

  const img = assetUrl(p.assetPath);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(p));
  const setV = (vid: string, patch: Partial<Draft['variants'][string]>) =>
    setDraft((d) => d && ({ ...d, variants: { ...d.variants, [vid]: { ...d.variants[vid]!, ...patch } } }));

  return (
    <>
      <Link to="/products" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Products</Link>
      <PageHeader
        title={p.name}
        subtitle={`/${p.slug}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge value={p.status} />
            <button className="btn-danger" disabled={del.isPending || save.isPending} onClick={() => { if (confirm(`Archive product "${p.name}" and its variants? Order history is preserved.`)) del.mutate(); }}>
              {del.isPending ? <Spinner /> : <><Trash2 size={15} /> Archive</>}
            </button>
            <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner className="text-white" /> : 'Save changes'}
            </button>
          </div>
        }
      />
      {(save.error || addVariant.error || del.error || delVariant.error) && (
        <div className="mb-4"><InlineAlert tone="critical">{((save.error || addVariant.error || del.error || delVariant.error) as Error).message}</InlineAlert></div>
      )}

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <FormSection title="Basics" description="Title, description, and core metadata shown to customers.">
            <Field label="Title"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="Description" hint="Markdown is not supported. Plain text only."><textarea className="input min-h-[120px]" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
          </FormSection>

          <FormSection title="Variants & inventory" description="Edit price, sale price, on-hand stock, and active state per variant.">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr>
                  <th className="th">Variant</th><th className="th">Price</th><th className="th">Sale</th><th className="th text-center">On hand</th><th className="th text-center">Active</th><th className="th"></th>
                </tr></thead>
                <tbody>
                  {p.variants.map((v: VariantRow) => {
                    const d = draft.variants[v.id]!;
                    return (
                      <tr key={v.id} className="border-t border-gray-100">
                        <td className="td"><div className="font-medium truncate max-w-[14rem]">{v.name}</div><div className="text-xs text-gray-400 truncate">{v.sku}{v.allocated > 0 && ` · ${v.allocated} allocated`}</div></td>
                        <td className="td"><CurrencyInput value={d.price} onChange={(val) => setV(v.id, { price: val })} cur={cur} /></td>
                        <td className="td"><CurrencyInput value={d.salePrice} placeholder="—" onChange={(val) => setV(v.id, { salePrice: val })} cur={cur} /></td>
                        <td className="td"><input className="input w-20 text-center mx-auto" type="number" min={0} value={d.onHand} onChange={(e) => setV(v.id, { onHand: e.target.value })} /></td>
                        <td className="td text-center"><input type="checkbox" className="h-4 w-4 accent-brand" checked={d.enabled} onChange={(e) => setV(v.id, { enabled: e.target.checked })} /></td>
                        <td className="td text-right"><button className="text-gray-300 hover:text-red-600" title="Delete variant" onClick={() => { if (confirm(`Delete variant ${v.sku}?`)) delVariant.mutate(v.id); }}><X size={16} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 pt-3">
              {nv ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="SKU"><input className="input w-32" value={nv.sku} onChange={(e) => setNv({ ...nv, sku: e.target.value })} /></Field>
                  <Field label="Name"><input className="input w-32" value={nv.name} onChange={(e) => setNv({ ...nv, name: e.target.value })} placeholder="e.g. Black / M" /></Field>
                  <Field label="Price"><input className="input w-24" inputMode="decimal" value={nv.price} onChange={(e) => setNv({ ...nv, price: e.target.value })} placeholder="0.00" /></Field>
                  <Field label="On hand"><input className="input w-20" type="number" min={0} value={nv.onHand} onChange={(e) => setNv({ ...nv, onHand: e.target.value })} /></Field>
                  <button className="btn-primary" disabled={addVariant.isPending} onClick={() => addVariant.mutate()}>{addVariant.isPending ? <Spinner className="text-white" /> : 'Add'}</button>
                  <button className="btn-ghost" onClick={() => setNv(null)}>Cancel</button>
                </div>
              ) : (
                <button className="btn-ghost" onClick={() => setNv({ sku: '', name: '', price: '', onHand: '0' })}><Plus size={15} /> Add variant</button>
              )}
            </div>
          </FormSection>
          <OptionsEditor productId={p.id} storeSlug={store?.slug} variants={p.variants.map((v) => ({ id: v.id, sku: v.sku, optionIds: v.optionIds }))} />
        </div>

        <div className="space-y-5">
          <FormSection title="Status" description="Only active products appear in your storefront and search.">
            <select className="input" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
            </select>
          </FormSection>
          <FormSection title="Media" description="Square crops work best. The first image is the one customers see in lists and search.">
            <div className="aspect-square rounded-lg bg-gray-100 grid place-items-center overflow-hidden relative">
              {img ? <img src={img} alt={p.name} className="h-full w-full object-cover" /> : <Package size={28} className="text-gray-300" />}
              {uploading && <div className="absolute inset-0 bg-white/60 grid place-items-center"><Spinner /></div>}
            </div>
            <div className="flex items-center gap-3 mt-2">
              <label className="btn-ghost cursor-pointer text-sm">
                <Upload size={14} /> {img ? 'Replace' : 'Upload'}
                <input type="file" accept="image/*" className="hidden" disabled={uploading}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); e.currentTarget.value = ''; }} />
              </label>
              {img && <button className="text-sm text-gray-400 hover:text-red-600" disabled={removeImage.isPending} onClick={() => removeImage.mutate()}>Remove</button>}
            </div>
            {uploadErr && <div className="text-xs text-red-600 mt-1">{uploadErr}</div>}
            {p.images.length > 0 && (
              <div className="grid grid-cols-3 gap-1.5 mt-3">
                {p.images.map((im) => (
                  <div key={im.assetId} className="group relative aspect-square rounded bg-gray-100 overflow-hidden ring-1 ring-gray-100">
                    <img src={assetUrl(im.path) ?? im.url} alt="" className="h-full w-full object-cover" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-1.5">
                      <button title="Set as featured" className="text-white text-xs bg-black/50 rounded px-1.5 py-0.5 hover:bg-black/70" disabled={setFeatured.isPending} onClick={() => setFeatured.mutate(im.assetId)}>★</button>
                      <button title="Remove from gallery" className="text-white text-xs bg-black/50 rounded px-1.5 py-0.5 hover:bg-red-600" disabled={removeFromGallery.isPending} onClick={() => removeFromGallery.mutate(im.assetId)}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <label className="btn-ghost cursor-pointer text-sm mt-2 inline-flex">
              <Upload size={14} /> Add to gallery
              <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) addToGallery(f); e.currentTarget.value = ''; }} />
            </label>
          </FormSection>
        </div>
      </div>
    </>
  );
}

type OptGroup = { id: string; name: string; options: { id: string; value: string }[] };
function OptionsEditor({ productId, storeSlug, variants }: { productId: string; storeSlug?: string; variants: { id: string; sku: string; optionIds?: string[] }[] }) {
  const qc = useQueryClient();
  const key = ['product-options', storeSlug, productId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<{ groups: OptGroup[] }>(`/products/${productId}/options`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  // Per-variant option assignment writes through PUT and refreshes the product
  // query (variant.optionIds lives on the product detail, not the options query).
  const setVariantOptions = useMutation({
    mutationFn: ({ variantId, optionIds }: { variantId: string; optionIds: string[] }) => api.put(`/variants/${variantId}/options`, { optionIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['product', storeSlug, productId] }),
  });
  const toggleVariantOption = (v: { id: string; optionIds?: string[] }, optionId: string) => {
    const cur = new Set(v.optionIds ?? []);
    if (cur.has(optionId)) cur.delete(optionId); else cur.add(optionId);
    setVariantOptions.mutate({ variantId: v.id, optionIds: [...cur] });
  };
  const [gName, setGName] = useState('');
  const [gValues, setGValues] = useState('');
  const [valInput, setValInput] = useState<Record<string, string>>({});
  const addGroup = useMutation({
    mutationFn: () => api.post(`/products/${productId}/option-groups`, { name: gName.trim(), values: gValues.split(',').map((v) => v.trim()).filter(Boolean) }),
    onSuccess: () => { setGName(''); setGValues(''); invalidate(); },
  });
  const addValue = useMutation({
    mutationFn: (groupId: string) => api.post(`/option-groups/${groupId}/options`, { value: (valInput[groupId] ?? '').trim() }),
    onSuccess: (_d, groupId) => { setValInput((m) => ({ ...m, [groupId]: '' })); invalidate(); },
  });
  const groups = data?.groups ?? [];
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Options</div>
      <div className="p-4 space-y-3">
        {isLoading ? <Spinner /> : groups.length === 0 ? <p className="text-sm text-gray-400">No option groups yet (e.g. Size, Color).</p> : groups.map((g) => (
          <div key={g.id} className="rounded-lg border border-gray-100 p-3">
            <div className="font-medium text-sm mb-2">{g.name}</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {g.options.map((o) => <span key={o.id} className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs">{o.value}</span>)}
              {g.options.length === 0 && <span className="text-xs text-gray-400">no values</span>}
            </div>
            <div className="flex gap-2">
              <input className="input py-1 text-sm" placeholder="Add value" value={valInput[g.id] ?? ''} onChange={(e) => setValInput((m) => ({ ...m, [g.id]: e.target.value }))} />
              <button className="btn-ghost text-sm" disabled={!(valInput[g.id] ?? '').trim() || addValue.isPending} onClick={() => addValue.mutate(g.id)}>Add</button>
            </div>
          </div>
        ))}
        <div className="border-t border-gray-100 pt-3 flex flex-wrap items-end gap-2">
          <div><label className="label">New group</label><input className="input w-32" placeholder="e.g. Size" value={gName} onChange={(e) => setGName(e.target.value)} /></div>
          <div><label className="label">Values (comma-sep)</label><input className="input w-44" placeholder="S, M, L" value={gValues} onChange={(e) => setGValues(e.target.value)} /></div>
          <button className="btn-primary" disabled={!gName.trim() || addGroup.isPending} onClick={() => addGroup.mutate()}>{addGroup.isPending ? <Spinner className="text-white" /> : <><Plus size={15} /> Add group</>}</button>
        </div>
        {(addGroup.error || addValue.error || setVariantOptions.error) && <div className="text-xs text-red-600">{((addGroup.error || addValue.error || setVariantOptions.error) as Error).message}</div>}
        {(() => {
          const allValues = groups.flatMap((g) => g.options.map((o) => ({ ...o, group: g.name })));
          if (!allValues.length || !variants.length) return null;
          return (
            <div className="border-t border-gray-100 pt-3">
              <div className="text-xs font-medium text-gray-500 mb-2">Assign values to variants</div>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead><tr><th className="text-left pr-2 pb-1"></th>{allValues.map((o) => <th key={o.id} className="px-1.5 pb-1 font-normal text-gray-500 whitespace-nowrap" title={o.group}>{o.value}</th>)}</tr></thead>
                  <tbody>
                    {variants.map((v) => (
                      <tr key={v.id}>
                        <td className="pr-2 py-0.5 font-medium whitespace-nowrap">{v.sku}</td>
                        {allValues.map((o) => (
                          <td key={o.id} className="px-1.5 text-center">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-brand" checked={(v.optionIds ?? []).includes(o.id)} disabled={setVariantOptions.isPending} onChange={() => toggleVariantOption(v, o.id)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function CurrencyInput({ value, onChange, cur, placeholder }: { value: string; onChange: (v: string) => void; cur: string; placeholder?: string }) {
  const sym = (0).toLocaleString('en-US', { style: 'currency', currency: cur }).replace(/[\d.,\s]/g, '') || '$';
  return (
    <div className="relative w-28">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">{sym}</span>
      <input className="input pl-6" inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
