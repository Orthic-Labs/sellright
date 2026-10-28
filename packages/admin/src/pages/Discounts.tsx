/**
 * #406 Discounts list. The editor lives at /discounts/new and /discounts/:id (DiscountEditor, exported below).
 * The condition builders the original page exported are re-exported here for Discounts.test.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, Search, Tag } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { money } from '../lib/format';
import { EmptyState, LoadError, LoadingRows } from '../redesign/states';
import { ConfirmDlg } from '../redesign/payments/Dlg';
import { DiscountEditor } from '../redesign/discounts/Editor';
import {
  PAGE_SIZE, SOON_MS, TABS, discountStatus, filterList, plural, tabCounts, typeLabel,
  type Promo, type SortKey, type TabId,
} from '../redesign/discounts/model';

export { buildConditions, buildPayload, fromLocalInput, hydrateForm, parseLimit, readCondition, scopeError, toLocalInput, verifiedError, VERIFIED_CATEGORIES } from '../redesign/discounts/model';
export type { FormState, ScopeKind } from '../redesign/discounts/model';
export { DiscountEditor };

type Pending = { kind: 'deactivate'; ids: string[] } | { kind: 'delete'; id: string };

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function Discounts() {
  const { store } = useAuth();
  const slug = store?.slug;
  const cur = store?.currency ?? 'USD';
  const canWrite = store?.role === 'owner' || store?.role === 'manager' || store?.role === 'staff';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [tab, setTab] = useState<TabId>('active');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('used');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const key = ['discounts', slug];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Promo[] }>('/discounts') });
  const invalidate = () => {
    qc.removeQueries({ queryKey: ['discount', slug] });
    void qc.invalidateQueries({ queryKey: ['discount-overlap', slug] });
    return qc.invalidateQueries({ queryKey: key });
  };

  const all = data?.items ?? [];
  // One clock per render so tabs, counts and pills can never disagree.
  const now = Date.now();
  const counts = useMemo(() => tabCounts(all, now), [all, now]);
  const rows = useMemo(() => filterList(all, tab, q, sort, now), [all, tab, q, sort, now]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pg = Math.min(page, pages - 1);
  const visible = rows.slice(pg * PAGE_SIZE, pg * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => { if (!menu) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [menu]);

  const setEnabled = async (ids: string[], enabled: boolean) => {
    const res = await Promise.allSettled(ids.map((id) => api.patch(`/discounts/${id}`, { enabled })));
    const ok = ids.filter((_, i) => res[i]!.status === 'fulfilled');
    await invalidate();
    return { ok, failed: ids.length - ok.length };
  };

  const deactivate = useMutation({
    mutationFn: (ids: string[]) => setEnabled(ids, false),
    onSuccess: ({ ok, failed }) => {
      setPending(null); setSel(new Set());
      if (failed) toast.error(`Couldn't deactivate ${plural(failed, 'code')}`, ok.length ? `${plural(ok.length, 'code')} deactivated.` : 'Nothing was changed.');
      if (ok.length) toast.push({ tone: 'success', title: `Deactivated ${plural(ok.length, 'code')}`, action: { label: 'Undo', onClick: () => { void setEnabled(ok, true); } } });
    },
  });
  const activate = useMutation({
    mutationFn: (id: string) => setEnabled([id], true),
    onSuccess: ({ failed }) => (failed ? toast.error("Couldn't activate it") : toast.success('Discount is active again')),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/discounts/${id}`),
    onSuccess: () => { setPending(null); void invalidate(); toast.success('Discount deleted'); },
    onError: (e) => { setPending(null); toast.error("Couldn't delete", (e as Error).message); },
  });

  const reset = () => { setPage(0); setSel(new Set()); };
  const fmtValue = (p: Promo) => {
    const base = p.type === 'percentage' ? `${p.value}%` : p.type === 'free_shipping' ? 'Free shipping' : money(p.value, cur);
    return p.freeShipping && p.type !== 'free_shipping' ? `${base} + free shipping` : base;
  };
  const pill = (p: Promo): [string, string] => {
    const s = discountStatus(p, now);
    if (s === 'disabled') return ['neu', 'Disabled'];
    if (s === 'expired') return ['neu', 'Expired'];
    if (s === 'scheduled') return ['info', `Starts ${p.startsAt ? shortDate(p.startsAt) : ''}`.trim()];
    return p.endsAt && Date.parse(p.endsAt) - now <= SOON_MS ? ['warn', 'Ends soon'] : ['ok', 'Active'];
  };
  const when = (p: Promo) => (p.startsAt && Date.parse(p.startsAt) > now ? `From ${shortDate(p.startsAt)}` : p.endsAt ? `Ends ${shortDate(p.endsAt)}` : 'No end date');
  const label = (p: Promo) => p.code ?? 'automatic';
  const menuRow = menu ? all.find((p) => p.id === menu.id) : undefined;
  const allSel = visible.length > 0 && visible.every((p) => sel.has(p.id));
  const bulkIds = [...sel].filter((id) => { const p = all.find((x) => x.id === id); return p && p.enabled; });
  const pendingRows = pending?.kind === 'deactivate' ? all.filter((p) => pending.ids.includes(p.id)) : [];
  const menuBtn = useRef<HTMLElement | null>(null);

  return (
    <div className="rd" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="ph">
        <h1>Discounts</h1>
        <span className="meta">{data ? plural(all.length, 'code') : ''}</span>
        <span className="sp" />
        {canWrite && <button className="btn pri" onClick={() => nav('/discounts/new')}><Plus size={14} aria-hidden="true" />New discount</button>}
      </div>
      <div className="tabs" role="tablist" aria-label="Discount status">
        {TABS.map((t) => (
          <button key={t.id} className="tab" role="tab" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} aria-controls="d-table"
            onClick={() => { setTab(t.id); reset(); }}>
            {t.label}{data && <> <b>{counts[t.id]}</b></>}
          </button>
        ))}
      </div>
      <div className="fbar">
        <label className="fsearch"><Search size={14} aria-hidden="true" />
          <input value={q} onChange={(e) => { setQ(e.target.value); reset(); }} placeholder="Search by code" aria-label="Search discounts by code" />
        </label>
        <span className="sp" />
        <label className="hint" htmlFor="d-sort">Sort</label>
        <select id="d-sort" className="inp sel" style={{ width: 150 }} value={sort} onChange={(e) => { setSort(e.target.value as SortKey); setPage(0); }}>
          <option value="used">Most used</option><option value="code">Code A to Z</option><option value="ends">Ending soonest</option>
        </select>
      </div>
      {sel.size > 0 && canWrite && (
        <div className="bulk" role="status">
          <span>{sel.size} selected</span><span className="sp" />
          <button className="btn sm dng" disabled={bulkIds.length === 0} onClick={() => setPending({ kind: 'deactivate', ids: bulkIds })}>Deactivate…</button>
          <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      <div className="tscroll" id="d-table" role="tabpanel">
        {isLoading ? <LoadingRows label="Loading discounts" rows={8} cols={[20, 120, 80, 0, 80]} />
          : error ? <div style={{ padding: '16px 24px' }}><LoadError what="discounts" detail={(error as Error).message} onRetry={() => void refetch()} /></div>
          : (
            <table className="rows">
              <thead><tr>
                <th style={{ width: 44 }}>{canWrite && <input type="checkbox" className="cb" checked={allSel} aria-label="Select all on this page" onChange={(e) => setSel(e.target.checked ? new Set([...sel, ...visible.map((p) => p.id)]) : new Set([...sel].filter((id) => !visible.some((p) => p.id === id))))} />}</th>
                <th>Code</th><th>Type</th><th>Value</th><th>Dates</th><th>Used</th><th>Status</th><th style={{ width: 44 }}><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr className="norow"><td colSpan={8}>
                    <EmptyState title={q ? 'No codes match that search' : all.length === 0 ? 'No discounts yet' : 'Nothing in this view'} icon={<Tag size={18} aria-hidden="true" />}
                      action={all.length === 0 && canWrite ? <button className="btn pri" onClick={() => nav('/discounts/new')}>New discount</button> : q ? <button className="btn" onClick={() => { setQ(''); reset(); }}>Clear search</button> : undefined}>
                      {q ? 'Try part of the code.' : all.length === 0 ? 'Create a code customers can use at checkout.' : 'No discounts have this status.'}
                    </EmptyState>
                  </td></tr>
                ) : visible.map((p) => {
                  const [tone, text] = pill(p);
                  return (
                    <tr key={p.id} data-id={p.id} tabIndex={0} onClick={() => nav(`/discounts/${p.id}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) nav(`/discounts/${p.id}`); }}>
                      <td onClick={(e) => e.stopPropagation()}>{canWrite && <input type="checkbox" className="cb" checked={sel.has(p.id)} aria-label={`Select ${label(p)}`} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(p.id); else n.delete(p.id); setSel(n); }} />}</td>
                      <td><button className="lnk mono" tabIndex={-1} onClick={(e) => { e.stopPropagation(); nav(`/discounts/${p.id}`); }}>{label(p)}</button></td>
                      <td className="muted">{typeLabel(p.type)}</td>
                      <td>{fmtValue(p)}</td>
                      <td className="muted">{when(p)}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="num" style={{ minWidth: 58, textAlign: 'left' }}>{p.usedCount}{p.usageLimit ? <span className="muted"> / {p.usageLimit}</span> : null}</span>
                          {p.usageLimit ? <span className="bar"><span style={{ width: `${Math.min(100, (p.usedCount / p.usageLimit) * 100)}%` }} /></span> : null}
                        </div>
                      </td>
                      <td><span className={`pill ${tone}`}>{text}</span></td>
                      <td style={{ paddingRight: 12 }} onClick={(e) => e.stopPropagation()}>
                        <button className="iconbtn" aria-label={`Actions for ${label(p)}`} aria-haspopup="menu"
                          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); menuBtn.current = e.currentTarget; setMenu({ id: p.id, x: Math.max(8, r.right - 200), y: r.bottom + 4 }); }}>
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
      <div className="foot">
        <span>{rows.length ? `${pg * PAGE_SIZE + 1}–${pg * PAGE_SIZE + visible.length} of ${rows.length}` : '0 codes'}</span>
        <span className="sp" />
        <button className="btn sm" disabled={pg === 0} onClick={() => setPage(pg - 1)}>Previous</button>
        <button className="btn sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</button>
      </div>

      {menu && menuRow && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => { setMenu(null); menuBtn.current?.focus(); }} aria-hidden="true" />
          <div className="menu" role="menu" style={{ left: menu.x, top: menu.y }}>
            <button role="menuitem" onClick={() => { setMenu(null); nav(`/discounts/${menuRow.id}`); }}>{canWrite ? 'Edit' : 'View'}</button>
            {canWrite && <button role="menuitem" onClick={() => { setMenu(null); nav(`/discounts/new?copy=${menuRow.id}`); }}>Duplicate</button>}
            {canWrite && <hr />}
            {canWrite && (menuRow.enabled
              ? <button role="menuitem" className="dng" onClick={() => { setMenu(null); setPending({ kind: 'deactivate', ids: [menuRow.id] }); }}>Deactivate…</button>
              : <button role="menuitem" onClick={() => { setMenu(null); activate.mutate(menuRow.id); }}>Activate</button>)}
            {canWrite && menuRow.usedCount === 0 && <button role="menuitem" className="dng" onClick={() => { setMenu(null); setPending({ kind: 'delete', id: menuRow.id }); }}>Delete…</button>}
          </div>
        </>
      )}

      {pending?.kind === 'deactivate' && (
        <ConfirmDlg open title={pendingRows.length > 1 ? `Deactivate ${pendingRows.length} codes?` : `Deactivate ${pendingRows[0] ? label(pendingRows[0]) : 'this code'}?`}
          confirmLabel="Deactivate" danger busy={deactivate.isPending} onClose={() => setPending(null)} onConfirm={() => deactivate.mutate(pending.ids)}>
          <p>Customers can't use {pendingRows.length > 1 ? 'these codes' : 'this code'} at checkout from now on. Orders that already used {pendingRows.length > 1 ? 'them' : 'it'} aren't changed.</p>
        </ConfirmDlg>
      )}
      {pending?.kind === 'delete' && (
        <ConfirmDlg open title={`Delete ${all.find((p) => p.id === pending.id)?.code ?? 'this discount'}?`} confirmLabel="Delete discount" danger busy={del.isPending}
          onClose={() => setPending(null)} onConfirm={() => del.mutate(pending.id)}>
          <p>This removes the discount for good. It has never been used, so no orders are affected. This can't be undone.</p>
        </ConfirmDlg>
      )}
    </div>
  );
}
