import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { api, type VariantRow } from '../../api';
import type { OptGroup } from './model';

export const optionsKey = (slug: string | undefined, productId: string) => ['product-options', slug, productId];

export function useProductOptions(productId: string, slug?: string) {
  return useQuery({ queryKey: optionsKey(slug, productId), queryFn: () => api.get<{ groups: OptGroup[] }>(`/products/${productId}/options`) });
}

/** Option groups, values and per-variant assignment. Every change here saves immediately (structure, not staged fields). */
export function OptionsCard({ productId, storeSlug, variants }: { productId: string; storeSlug?: string; variants: Pick<VariantRow, 'id' | 'sku' | 'optionIds'>[] }) {
  const qc = useQueryClient();
  const key = optionsKey(storeSlug, productId);
  const { data, isLoading, error } = useProductOptions(productId, storeSlug);
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  // Reorder endpoints need an exact permutation of the current set, so send the full order with two neighbours swapped.
  const reorderGroups = useMutation({ mutationFn: (order: string[]) => api.put(`/products/${productId}/option-groups/reorder`, { order }), onSuccess: invalidate });
  const reorderOptions = useMutation({ mutationFn: ({ groupId, order }: { groupId: string; order: string[] }) => api.put(`/option-groups/${groupId}/options/reorder`, { order }), onSuccess: invalidate });
  const swap = (ids: string[], i: number, dir: -1 | 1) => { const t = i + dir; if (t < 0 || t >= ids.length) return null; const o = [...ids]; [o[i], o[t]] = [o[t]!, o[i]!]; return o; };
  const moveGroup = (groups: OptGroup[], i: number, dir: -1 | 1) => { const o = swap(groups.map((g) => g.id), i, dir); if (o) reorderGroups.mutate(o); };
  const moveOption = (g: OptGroup, i: number, dir: -1 | 1) => { const o = swap(g.options.map((x) => x.id), i, dir); if (o) reorderOptions.mutate({ groupId: g.id, order: o }); };
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
  const allValues = groups.flatMap((g) => g.options.map((o) => ({ ...o, group: g.name })));
  const err = (error || addGroup.error || addValue.error || setVariantOptions.error || reorderGroups.error || reorderOptions.error) as Error | null;

  return (
    <div className="card">
      <div className="ch"><h2>Options</h2><span className="hint">Variants are built from these. Changes here save straight away.</span></div>
      <div className="cb-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
        {isLoading ? <div className="sk" style={{ width: 120, margin: '10px 0' }} role="status" aria-label="Loading options" />
          : groups.length === 0 ? <p className="hint" style={{ padding: '8px 0' }}>No option groups yet (for example Size or Colour).</p>
          : groups.map((g, gi) => (
            <div key={g.id} className="opt">
              <span className="name" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
                  <button type="button" className="iconbtn" style={{ width: 18, height: 12 }} aria-label={`Move ${g.name} up`} disabled={gi === 0 || reorderGroups.isPending} onClick={() => moveGroup(groups, gi, -1)}><ChevronUp size={12} aria-hidden="true" /></button>
                  <button type="button" className="iconbtn" style={{ width: 18, height: 12 }} aria-label={`Move ${g.name} down`} disabled={gi === groups.length - 1 || reorderGroups.isPending} onClick={() => moveGroup(groups, gi, 1)}><ChevronDown size={12} aria-hidden="true" /></button>
                </span>
                {g.name}
              </span>
              {g.options.map((o, oi) => (
                <span key={o.id} className="tag">
                  <button type="button" className="iconbtn" style={{ width: 16, height: 16 }} aria-label={`Move ${o.value} earlier`} disabled={oi === 0 || reorderOptions.isPending} onClick={() => moveOption(g, oi, -1)}><ChevronUp size={11} aria-hidden="true" style={{ transform: 'rotate(-90deg)' }} /></button>
                  {o.value}
                  <button type="button" className="iconbtn" style={{ width: 16, height: 16 }} aria-label={`Move ${o.value} later`} disabled={oi === g.options.length - 1 || reorderOptions.isPending} onClick={() => moveOption(g, oi, 1)}><ChevronDown size={11} aria-hidden="true" style={{ transform: 'rotate(-90deg)' }} /></button>
                </span>
              ))}
              {g.options.length === 0 && <span className="hint">no values</span>}
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <input className="inp" style={{ width: 110, height: 26 }} placeholder="Add value" aria-label={`Add a value to ${g.name}`} value={valInput[g.id] ?? ''}
                  onChange={(e) => setValInput((m) => ({ ...m, [g.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (valInput[g.id] ?? '').trim() && !addValue.isPending) addValue.mutate(g.id); }} />
                <button type="button" className="btn ghost sm" disabled={!(valInput[g.id] ?? '').trim() || addValue.isPending} onClick={() => addValue.mutate(g.id)}><Plus aria-hidden="true" />Value</button>
              </span>
            </div>
          ))}
        <div className="opt" style={{ alignItems: 'flex-end' }}>
          <div className="fld"><label htmlFor="og-name">New group</label><input id="og-name" className="inp" style={{ width: 130 }} placeholder="e.g. Size" value={gName} onChange={(e) => setGName(e.target.value)} /></div>
          <div className="fld"><label htmlFor="og-vals">Values, comma separated</label><input id="og-vals" className="inp" style={{ width: 200 }} placeholder="S, M, L" value={gValues} onChange={(e) => setGValues(e.target.value)} /></div>
          <button type="button" className="btn" disabled={!gName.trim() || addGroup.isPending} onClick={() => addGroup.mutate()}><Plus aria-hidden="true" />Add group</button>
        </div>
        {err && <div className="err" role="alert" style={{ padding: '6px 0' }}>{err.message}</div>}
        {allValues.length > 0 && variants.length > 0 && (
          <details style={{ padding: '8px 0 10px' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Assign values to variants</summary>
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: 'auto' }}>
                <thead><tr><th scope="col"><span hidden>Variant</span></th>{allValues.map((o) => <th key={o.id} scope="col" title={o.group} style={{ position: 'static' }}>{o.value}</th>)}</tr></thead>
                <tbody>
                  {variants.map((v) => (
                    <tr key={v.id}>
                      <td className="mono" style={{ padding: '0 8px' }}>{v.sku}</td>
                      {allValues.map((o) => (
                        <td key={o.id} style={{ textAlign: 'center', padding: '0 8px', height: 30 }}>
                          <input type="checkbox" className="cb" aria-label={`${v.sku}: ${o.group} ${o.value}`} checked={(v.optionIds ?? []).includes(o.id)} disabled={setVariantOptions.isPending} onChange={() => toggleVariantOption(v, o.id)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
