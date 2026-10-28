import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type CollectionDetail, type CollectionRow } from '../../api';
import { useToast } from '../../components/Toast';

const MAX_SCAN = 60;

/** Collections this product is in. The API has no "collections of a product" endpoint, so membership is read from each collection. Changes save immediately. */
export function CollectionsCard({ productId, storeSlug, slug }: { productId: string; storeSlug?: string; slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['product-collections', storeSlug, productId];
  const [pickVal, setPickVal] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const list = (await api.get<{ items: CollectionRow[] }>('/collections')).items;
      const scan = list.slice(0, MAX_SCAN);
      const details = await Promise.all(scan.map((c) => api.get<CollectionDetail>(`/collections/${c.id}`)));
      const member = new Set(scan.filter((_, i) => details[i]!.products.some((x) => x.id === productId)).map((c) => c.id));
      return { all: list, member, truncated: list.length > MAX_SCAN };
    },
  });
  const add = useMutation({
    mutationFn: (cid: string) => api.post(`/collections/${cid}/products`, { productId }),
    onSuccess: () => { setPickVal(''); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => toast.error('Add to collection failed', (e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (cid: string) => api.del(`/collections/${cid}/products/${productId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error('Remove from collection failed', (e as Error).message),
  });
  const members = data ? data.all.filter((c) => data.member.has(c.id)) : [];
  const others = data ? data.all.filter((c) => !data.member.has(c.id)) : [];
  return (
    <div className="card">
      <div className="ch"><h2>Organisation</h2></div>
      <div className="cb-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="fld">
          <span className="fl-l">Collections</span>
          {isLoading ? <div className="sk" style={{ width: 100 }} role="status" aria-label="Loading collections" />
            : error ? <span className="err" role="alert">Couldn't load collections. {(error as Error).message}</span>
            : (
              <>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {members.length === 0 && <span className="hint">Not in any collection.</span>}
                  {members.map((c) => (
                    <span key={c.id} className="tag">{c.name}
                      <button type="button" className="iconbtn" style={{ width: 18, height: 18 }} aria-label={`Remove from ${c.name}`} disabled={remove.isPending} onClick={() => remove.mutate(c.id)}><X size={11} aria-hidden="true" /></button>
                    </span>
                  ))}
                </div>
                {others.length > 0 && (
                  <select className="inp sel" aria-label="Add to a collection" value={pickVal} disabled={add.isPending}
                    onChange={(e) => { setPickVal(e.target.value); if (e.target.value) add.mutate(e.target.value); }}>
                    <option value="">Add to collection…</option>
                    {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
                {data?.truncated && <span className="hint">Only the first {MAX_SCAN} collections were checked for membership.</span>}
                <span className="hint">Collection changes save straight away.</span>
              </>
            )}
        </div>
        <div className="fld"><span className="fl-l">URL</span><div className="mono muted">/{slug}</div></div>
      </div>
    </div>
  );
}
