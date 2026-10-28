import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type InventoryRow, type Page } from '../../api';
import { useToast } from '../../components/Toast';
import { isInt, isMoney, toCents } from './model';

export type VariantSeed = { name: string; optionIds?: string[] };

/** Looks the SKU up in the real catalogue. Returns an error message, or '' when free. */
export async function skuProblem(sku: string, own: { sku: string }[]): Promise<string> {
  const s = sku.trim();
  if (!s) return 'Enter a SKU.';
  if (own.some((v) => v.sku.toLowerCase() === s.toLowerCase())) return 'A variant of this product already uses this SKU.';
  const r = await api.get<Page<InventoryRow>>(`/inventory?q=${encodeURIComponent(s)}&pageSize=100`);
  const hit = r.items.find((i) => i.sku.toLowerCase() === s.toLowerCase());
  return hit ? `SKU already used by ${hit.productName} · ${hit.name}.` : '';
}

/** Inline add-variant row. Creating a variant is a structural change and saves immediately (the copy says so). */
export function AddVariant({ productId, storeSlug, ownVariants, seed, onDone, onCancel }: {
  productId: string; storeSlug?: string; ownVariants: { sku: string }[]; seed: VariantSeed; onDone: () => void; onCancel: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ sku: '', name: seed.name, price: '', onHand: '0' });
  const [errs, setErrs] = useState<{ sku?: string; name?: string; price?: string; onHand?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const checked = useRef<{ sku: string; msg: string } | null>(null);

  const checkSku = async (): Promise<string> => {
    const sku = f.sku.trim();
    if (checked.current?.sku === sku) return checked.current.msg;
    let msg: string;
    try { msg = await skuProblem(sku, ownVariants); } catch { msg = ''; /* server still enforces uniqueness (409) */ }
    checked.current = { sku, msg };
    setErrs((e) => ({ ...e, sku: msg || undefined }));
    return msg;
  };

  const submit = async () => {
    const e: typeof errs = {};
    if (!f.name.trim()) e.name = 'Enter a name.';
    if (!isMoney(f.price) || !(Number(f.price) > 0)) e.price = 'Enter a price above 0, like 40.00.';
    if (!isInt(f.onHand)) e.onHand = 'Whole number, 0 or more.';
    setBusy(true);
    const skuMsg = await checkSku();
    if (skuMsg) e.sku = skuMsg;
    if (Object.keys(e).length) { setErrs(e); setBusy(false); return; }
    try {
      const created = await api.post<{ id: string }>(`/products/${productId}/variants`, { sku: f.sku.trim(), name: f.name.trim(), price: toCents(f.price), onHand: Number(f.onHand) });
      if (seed.optionIds?.length) await api.put(`/variants/${created.id}/options`, { optionIds: seed.optionIds });
      await qc.invalidateQueries({ queryKey: ['product', storeSlug, productId] });
      toast.success(`Added ${f.name.trim()}.`);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setErrs({ sku: 'That SKU is already in use.' });
      else setErrs({ form: (err as Error).message });
    } finally { setBusy(false); }
  };

  const fld = (id: string, label: string, err: string | undefined, input: React.ReactNode) => (
    <div className="fld"><label htmlFor={id}>{label}</label>{input}<div className="err" id={`${id}-e`}>{err}</div></div>
  );
  return (
    <div className="cb-body" style={{ borderTop: '1px solid rgb(var(--border))', background: 'rgb(var(--bg))' }} role="group" aria-label="Add variant">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
        {fld('av-sku', 'SKU', errs.sku, <input id="av-sku" className={`inp mono${errs.sku ? ' bad' : ''}`} style={{ width: 150 }} value={f.sku} aria-invalid={!!errs.sku} aria-describedby="av-sku-e" autoFocus
          onChange={(e) => { setF({ ...f, sku: e.target.value }); setErrs((x) => ({ ...x, sku: undefined })); }} onBlur={() => { if (f.sku.trim()) void checkSku(); }} />)}
        {fld('av-name', 'Name', errs.name, <input id="av-name" className={`inp${errs.name ? ' bad' : ''}`} style={{ width: 170 }} value={f.name} placeholder="e.g. Black / M" aria-invalid={!!errs.name} aria-describedby="av-name-e" onChange={(e) => setF({ ...f, name: e.target.value })} />)}
        {fld('av-price', 'Price', errs.price, <input id="av-price" className={`inp${errs.price ? ' bad' : ''}`} style={{ width: 90 }} inputMode="decimal" placeholder="0.00" value={f.price} aria-invalid={!!errs.price} aria-describedby="av-price-e" onChange={(e) => setF({ ...f, price: e.target.value })} />)}
        {fld('av-oh', 'On hand', errs.onHand, <input id="av-oh" className={`inp num${errs.onHand ? ' bad' : ''}`} style={{ width: 74 }} inputMode="numeric" value={f.onHand} aria-invalid={!!errs.onHand} aria-describedby="av-oh-e" onChange={(e) => setF({ ...f, onHand: e.target.value })} />)}
        <div style={{ display: 'flex', gap: 6, marginTop: 22 }}>
          <button type="button" className="btn pri" disabled={busy} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add variant'}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
      {errs.form && <div className="err" role="alert" style={{ marginTop: 6 }}>{errs.form}</div>}
      <div className="hint" style={{ marginTop: 6 }}>Adding a variant saves it straight away. It does not wait for Save changes.</div>
    </div>
  );
}
