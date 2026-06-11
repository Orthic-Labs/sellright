import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Package, Trash2, Plus, X, Upload } from 'lucide-react';
import { api, assetUrl, uploadAsset, type ProductDetail, type VariantRow } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, Spinner } from '../components/ui';

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['product', store?.slug, id] }),
  });

  const nav = useNavigate();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['product', store?.slug, id] });
  const del = useMutation({ mutationFn: () => api.del(`/products/${id}`), onSuccess: () => nav('/products') });
  const delVariant = useMutation({ mutationFn: (vid: string) => api.del(`/variants/${vid}`), onSuccess: invalidate });
  const [nv, setNv] = useState<{ sku: string; name: string; price: string; onHand: string } | null>(null);
  const addVariant = useMutation({
    mutationFn: async () => {
      if (!nv) return;
      const price = toCents(nv.price); const onHand = Number(nv.onHand || '0');
      if (!nv.sku.trim() || !nv.name.trim() || Number.isNaN(price) || !Number.isInteger(onHand) || onHand < 0) throw new Error('SKU, name, valid price and stock required');
      await api.post(`/products/${id}/variants`, { sku: nv.sku, name: nv.name, price, onHand });
    },
    onSuccess: () => { setNv(null); invalidate(); },
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
    } catch (e) { setUploadErr((e as Error).message); }
    finally { setUploading(false); }
  }
  const removeImage = useMutation({ mutationFn: () => api.patch(`/products/${id}`, { featuredAssetId: null }), onSuccess: invalidate });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote message={(error as Error).message} />;
  if (!p || !draft) return null;

  const img = assetUrl(p.assetPath);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(p));
  const setV = (vid: string, patch: Partial<Draft['variants'][string]>) =>
    setDraft((d) => d && ({ ...d, variants: { ...d.variants, [vid]: { ...d.variants[vid]!, ...patch } } }));

  return (
    <>
      <Link to="/products" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Products</Link>
      <div className="flex items-center justify-between mb-5 gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{p.name}</h1>
        <div className="flex items-center gap-2">
          <button className="btn-danger" disabled={del.isPending} onClick={() => { if (confirm(`Archive product "${p.name}" and its variants? Order history is preserved.`)) del.mutate(); }}>
            {del.isPending ? <Spinner /> : <><Trash2 size={15} /> Delete</>}
          </button>
          <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner className="text-white" /> : 'Save changes'}
          </button>
        </div>
      </div>
      {(save.error || addVariant.error || del.error) && <div className="mb-4"><ErrorNote message={((save.error || addVariant.error || del.error) as Error).message} /></div>}

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <div className="card p-4 space-y-4">
            <div><label className="label">Title</label><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            <div><label className="label">Description</label><textarea className="input min-h-[120px]" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Variants & inventory</div>
            <table className="w-full">
              <thead><tr>
                <th className="th">Variant</th><th className="th">Price</th><th className="th">Sale</th><th className="th text-center">On hand</th><th className="th text-center">Active</th><th className="th"></th>
              </tr></thead>
              <tbody>
                {p.variants.map((v: VariantRow) => {
                  const d = draft.variants[v.id]!;
                  return (
                    <tr key={v.id} className="border-t border-gray-100">
                      <td className="td"><div className="font-medium">{v.name}</div><div className="text-xs text-gray-400">{v.sku}{v.allocated > 0 && ` · ${v.allocated} allocated`}</div></td>
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
            <div className="border-t border-gray-100 p-3">
              {nv ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div><label className="label">SKU</label><input className="input w-32" value={nv.sku} onChange={(e) => setNv({ ...nv, sku: e.target.value })} /></div>
                  <div><label className="label">Name</label><input className="input w-32" value={nv.name} onChange={(e) => setNv({ ...nv, name: e.target.value })} placeholder="e.g. Black / M" /></div>
                  <div><label className="label">Price</label><input className="input w-24" inputMode="decimal" value={nv.price} onChange={(e) => setNv({ ...nv, price: e.target.value })} placeholder="0.00" /></div>
                  <div><label className="label">On hand</label><input className="input w-20" type="number" min={0} value={nv.onHand} onChange={(e) => setNv({ ...nv, onHand: e.target.value })} /></div>
                  <button className="btn-primary" disabled={addVariant.isPending} onClick={() => addVariant.mutate()}>{addVariant.isPending ? <Spinner className="text-white" /> : 'Add'}</button>
                  <button className="btn-ghost" onClick={() => setNv(null)}>Cancel</button>
                </div>
              ) : (
                <button className="btn-ghost" onClick={() => setNv({ sku: '', name: '', price: '', onHand: '0' })}><Plus size={15} /> Add variant</button>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="card p-4">
            <label className="label">Status</label>
            <select className="input" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
            </select>
          </div>
          <div className="card p-3">
            <label className="label">Featured image</label>
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
            <div className="text-xs text-gray-400 mt-2 truncate">/{p.slug}</div>
          </div>
        </div>
      </div>
    </>
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
