import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Package } from 'lucide-react';
import { api, assetUrl, type ProductDetail, type VariantRow } from '../api';
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
        <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner className="text-white" /> : 'Save changes'}
        </button>
      </div>
      {save.error && <div className="mb-4"><ErrorNote message={(save.error as Error).message} /></div>}

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
                <th className="th">Variant</th><th className="th">Price</th><th className="th">Sale</th><th className="th text-center">On hand</th><th className="th text-center">Active</th>
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
            <div className="aspect-square rounded-lg bg-gray-100 grid place-items-center overflow-hidden">
              {img ? <img src={img} alt={p.name} className="h-full w-full object-cover" /> : <Package size={28} className="text-gray-300" />}
            </div>
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
