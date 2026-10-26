import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { PageHeader, Spinner, InlineAlert, EmptyStateActionPanel } from '../components/ui';

interface TreeVariant { id: string; name: string; sku: string; enabled: boolean; onHand: number; allocated: number }
interface TreeProduct { id: string; name: string; enabled: boolean; variants: TreeVariant[] }
interface Tree { items: TreeProduct[]; total: number; truncated: boolean }

// PATCH /variants/stock/bulk accepts at most 500 items per call, all-or-nothing.
const MAX_ITEMS = 500;

const available = (v: TreeVariant) => Math.max(0, v.onHand - v.allocated);
const isValid = (raw: string) => /^\d+$/.test(raw.trim());

/**
 * Bulk Stock (Vendure order-tools BulkStockPage parity): product -> variant
 * tree, a different new on-hand value per variant, and one Save for all of
 * them. Saving goes through PATCH /variants/stock/bulk, so it stays a single
 * transaction with a stock movement and audit row per variant.
 */
export default function BulkStock() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [newStock, setNewStock] = useState<Record<string, string>>({}); // variantId -> typed value
  const [saved, setSaved] = useState<Record<string, number>>({}); // variantId -> confirmed value
  const [filter, setFilter] = useState('');
  const [showZero, setShowZero] = useState(true);
  const [showDisabled, setShowDisabled] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<string | null>(null);

  const queryKey = ['stock-tree', store?.slug];
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.get<Tree>('/stock/tree', { signal }),
  });

  const filled = useMemo(() => Object.entries(newStock).filter(([, v]) => v.trim() !== ''), [newStock]);
  const changedCount = filled.length;
  const invalidCount = filled.filter(([, v]) => !isValid(v)).length;
  const tooMany = changedCount > MAX_ITEMS;

  const products = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((p) => showDisabled || p.enabled)
      .map((p) => ({
        ...p,
        variants: p.variants.filter((v) => {
          if (!showDisabled && !v.enabled) return false;
          const matchFilter = !needle || v.sku.toLowerCase().includes(needle) || v.name.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle);
          const matchZero = showZero || v.onHand > 0 || (newStock[v.id] ?? '').trim() !== '';
          return matchFilter && matchZero;
        }),
      }))
      .filter((p) => p.variants.length > 0);
  }, [data, filter, showZero, showDisabled, newStock]);

  const save = useMutation({
    mutationFn: (items: { id: string; onHand: number }[]) => api.patch<{ updated: { id: string; onHand: number }[] }>('/variants/stock/bulk', { items }),
    onSuccess: (d) => {
      const confirmed = new Map(d.updated.map((u) => [u.id, u.onHand]));
      // Reflect confirmed on-hand values in place; allocated is untouched by a set.
      qc.setQueryData<Tree>(queryKey, (t) => t && ({
        ...t,
        items: t.items.map((p) => ({ ...p, variants: p.variants.map((v) => (confirmed.has(v.id) ? { ...v, onHand: confirmed.get(v.id)! } : v)) })),
      }));
      setSaved((cur) => ({ ...cur, ...Object.fromEntries(confirmed) }));
      setNewStock({});
      setResult(`Updated ${d.updated.length} variant${d.updated.length === 1 ? '' : 's'} successfully.`);
      void qc.invalidateQueries({ queryKey: ['inventory', store?.slug] });
      toast.success('Stock saved', `${d.updated.length} variant${d.updated.length === 1 ? '' : 's'} updated`);
    },
    // The endpoint is atomic: on any failure nothing was written, so the typed values stay for a retry.
    onError: (e) => { setResult(null); toast.error('Bulk stock save failed', (e as Error).message); },
  });

  const doSave = () => {
    if (!changedCount || invalidCount || tooMany) return;
    setResult(null);
    save.mutate(filled.map(([id, v]) => ({ id, onHand: parseInt(v, 10) })));
  };

  const refresh = () => { setNewStock({}); setSaved({}); setResult(null); setExpanded({}); void refetch(); };

  return (
    <>
      <PageHeader
        title="Bulk stock update"
        subtitle="View and update stock levels across all products and variants. Only filled fields are submitted, and Save applies them all at once."
        actions={<Link to="/inventory" className="btn-ghost btn-sm">Back to Inventory</Link>}
      />

      {isLoading && <div className="text-sm text-gray-400 flex items-center gap-2"><Spinner /> Loading products…</div>}
      {error && <InlineAlert tone="critical" title="Could not load products">{(error as Error).message} <button className="underline" onClick={() => refetch()}>Retry</button></InlineAlert>}
      {data?.truncated && <InlineAlert tone="attention" title="Showing the first products only">The store has more products than this page loads; use Inventory for the rest.</InlineAlert>}

      {data && (
        <div className="stack-y-4">
          <div className="card p-3">
            <div className="flex flex-wrap items-center gap-3">
              <input className="input w-60" type="text" placeholder="Filter by product / SKU…" aria-label="Filter by product or SKU" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <label className="flex items-center gap-1.5 text-sm cursor-pointer"><input type="checkbox" checked={showZero} onChange={() => setShowZero((v) => !v)} /> Show zero-stock</label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer"><input type="checkbox" checked={showDisabled} onChange={() => setShowDisabled((v) => !v)} /> Show disabled</label>
              <button className="btn-ghost btn-sm" onClick={() => setExpanded(Object.fromEntries(products.map((p) => [p.id, true])))}>Expand all</button>
              <button className="btn-ghost btn-sm" onClick={() => setExpanded({})}>Collapse all</button>
              <button className="btn-ghost btn-sm" disabled={isFetching} onClick={refresh}>Refresh</button>
              <span className="ml-auto text-sm text-gray-500">{products.length} products — <strong className="tnum">{changedCount}</strong> changed</span>
            </div>
          </div>

          {products.length === 0 ? (
            <EmptyStateActionPanel
              title={filter ? 'No matching variants' : 'No products to show'}
              description={filter ? 'No variants match your filter.' : 'Nothing matches the current zero-stock / disabled settings.'}
              actions={filter ? [{ label: 'Clear filter', variant: 'ghost', onClick: () => setFilter('') }] : []}
            />
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col style={{ width: '36%' }} /><col style={{ width: '14%' }} /><col style={{ width: '10%' }} /><col style={{ width: '10%' }} /><col style={{ width: '10%' }} /><col style={{ width: '20%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="th text-left">Product / Variant</th>
                    <th className="th text-left">SKU</th>
                    <th className="th text-right">On hand</th>
                    <th className="th text-right">Allocated</th>
                    <th className="th text-right">Available</th>
                    <th className="th text-left">New stock</th>
                  </tr>
                </thead>
                <tbody>
                  {products.flatMap((p) => [
                    <tr key={`p-${p.id}`} className="bg-gray-50 cursor-pointer" onClick={() => setExpanded((cur) => ({ ...cur, [p.id]: !cur[p.id] }))}>
                      <td className="td font-semibold" colSpan={6}>
                        <button type="button" className="inline-flex items-center gap-1.5 text-left" aria-expanded={!!expanded[p.id]}>
                          {expanded[p.id] ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                          <span className={p.enabled ? '' : 'text-gray-400'}>{p.name}</span>
                          {!p.enabled && <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-px rounded font-normal">disabled</span>}
                          <span className="text-xs text-gray-400 font-normal">{p.variants.length} variant{p.variants.length === 1 ? '' : 's'}</span>
                        </button>
                      </td>
                    </tr>,
                    ...(expanded[p.id] ? p.variants.map((v) => {
                      const typed = newStock[v.id] ?? '';
                      const hasChange = typed.trim() !== '';
                      const bad = hasChange && !isValid(typed);
                      const savedVal = saved[v.id];
                      return (
                        <tr key={`v-${v.id}`} className={hasChange ? 'bg-yellow-50' : savedVal !== undefined ? 'bg-green-50' : ''}>
                          <td className="td pl-8 text-xs">{v.name || '—'}{!v.enabled && <span className="ml-2 text-[10px] text-gray-400">disabled</span>}</td>
                          <td className="td font-mono text-xs text-gray-500">{v.sku}</td>
                          <td className="td text-right tnum">{v.onHand}</td>
                          <td className={`td text-right tnum ${v.allocated > 0 ? 'text-warning' : 'text-gray-400'}`}>{v.allocated || '—'}</td>
                          <td className={`td text-right tnum font-medium ${available(v) > 0 ? 'text-success' : 'text-danger'}`}>{available(v)}</td>
                          <td className="td">
                            <input
                              className={`input w-24 text-right tnum py-1.5 ${bad ? 'border-danger/60' : ''}`}
                              type="number" min={0} step={1}
                              aria-label={`New on-hand for ${v.sku}`} aria-invalid={bad}
                              placeholder={String(v.onHand)} value={typed}
                              onChange={(e) => setNewStock((cur) => ({ ...cur, [v.id]: e.target.value }))}
                            />
                            {savedVal !== undefined && !hasChange && <span className="text-xs text-success ml-2">✓ saved</span>}
                          </td>
                        </tr>
                      );
                    }) : []),
                  ])}
                </tbody>
              </table>
            </div>
          )}

          {changedCount > 0 && (
            <div className="card p-3 flex flex-wrap items-center gap-3" aria-live="polite">
              <span className="text-sm text-gray-600">
                {changedCount} variant{changedCount === 1 ? '' : 's'} will be updated
                {invalidCount > 0 && <span className="text-danger"> — {invalidCount} value{invalidCount === 1 ? ' is' : 's are'} not a whole number of 0 or more</span>}
                {tooMany && <span className="text-danger"> — at most {MAX_ITEMS} per save</span>}
              </span>
              <button className="btn-primary" disabled={save.isPending || invalidCount > 0 || tooMany} onClick={doSave}>
                {save.isPending ? <Spinner className="text-white" /> : <Check size={15} />} {save.isPending ? 'Saving…' : 'Save stock'}
              </button>
              <button className="btn-ghost" disabled={save.isPending} onClick={() => setNewStock({})}>Clear changes</button>
            </div>
          )}

          {result && <InlineAlert tone="positive" title={result} />}
        </div>
      )}
    </>
  );
}
