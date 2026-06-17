import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ArrowRight, ShoppingBag, Package, Users, FileText, Mail, BarChart3, Gift, Settings, Warehouse, HandCoins, Receipt, Webhook, Coins, RotateCcw, Layers, Percent, Boxes, Activity, Shield, Plus, Upload, ShoppingCart, BadgeCheck } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from './Toast';

/**
 * Global command palette (Ctrl+K / Cmd+K).
 *
 * Three sources of results, displayed in this order:
 *   1. Local commands — routes, "new X" actions, settings/staff/report
 *      shortcuts. No network call. Always present.
 *   2. Remote search — `GET /v1/admin/search?q=...`, grouped into Orders,
 *      Products, Customers. Debounced 200ms. No call for 0–1 char queries.
 *   3. Recent — last few commands executed in this session (in-memory only).
 *
 * Keyboard contract:
 *   - opens with Ctrl/Cmd+K; close with Escape, click-outside, or empty
 *     search + Escape (which just closes).
 *   - ArrowUp/Down move the active item; Enter executes it.
 *   - ignored when the active element is an input/textarea/contenteditable
 *     UNLESS the user holds Ctrl/Cmd — the Ctrl+K shortcut still fires.
 *   - focus returns to the previously focused element on close.
 *   - the "type to search" filter on commands is a case-insensitive substring
 *     match against label, keywords, and section.
 *
 * Metrics are surfaced via `useToast().recordEvent` for the future in-app
 * activity widget — pages don't need to read this directly.
 */

interface LocalCommand {
  id: string;
  label: string;
  hint?: string;
  section: string;
  keywords?: string[];
  to?: string;
  action?: () => void;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
}

interface SearchResult {
  orders: { code: string; state: string; email: string | null }[];
  products: { id: string; name: string; status: string }[];
  customers: { id: string; email: string; firstName: string | null; lastName: string | null }[];
}

const RECENT_KEY = 'sr_palette_recent';
const RECENT_MAX = 6;

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [searchData, setSearchData] = useState<SearchResult | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const { store } = useAuth();
  const { recordEvent } = useToast();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read recent list from sessionStorage on mount.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(RECENT_KEY);
      if (raw) setRecent(JSON.parse(raw));
    } catch { /* sessionStorage may be disabled — fall back to empty */ }
  }, []);

  const remember = useCallback((id: string) => {
    setRecent((cur) => {
      const next = [id, ...cur.filter((x) => x !== id)].slice(0, RECENT_MAX);
      try { sessionStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  // Build the local command list. Pulled from a single source so the
  // shortcuts match the IA in Layout.tsx (don't drift). Group by section
  // so the result list reads top-to-bottom by importance.
  const localCommands: LocalCommand[] = useMemo(() => [
    { id: 'go:orders', label: 'Go to Orders', section: 'Navigate', keywords: ['orders','fulfill','shipping'], to: '/orders', icon: ShoppingBag },
    { id: 'go:products', label: 'Go to Products', section: 'Navigate', keywords: ['products','catalog'], to: '/products', icon: Package },
    { id: 'go:customers', label: 'Go to Customers', section: 'Navigate', keywords: ['customers','users'], to: '/customers', icon: Users },
    { id: 'go:collections', label: 'Go to Collections', section: 'Navigate', keywords: ['collections'], to: '/collections', icon: Layers },
    { id: 'go:inventory', label: 'Go to Inventory', section: 'Navigate', keywords: ['inventory','stock'], to: '/inventory', icon: Boxes },
    { id: 'go:returns', label: 'Go to Returns', section: 'Navigate', keywords: ['returns','rma'], to: '/returns', icon: RotateCcw },
    { id: 'go:locations', label: 'Go to Locations', section: 'Navigate', keywords: ['locations','warehouse'], to: '/locations', icon: Warehouse },
    { id: 'go:discounts', label: 'Go to Discounts', section: 'Navigate', keywords: ['discounts','promotions'], to: '/discounts', icon: Percent },
    { id: 'go:gift-cards', label: 'Go to Gift cards', section: 'Navigate', keywords: ['gift cards','vouchers'], to: '/gift-cards', icon: Gift },
    { id: 'go:affiliates', label: 'Go to Affiliates', section: 'Navigate', keywords: ['affiliates'], to: '/affiliates', icon: HandCoins },
    { id: 'go:marketing', label: 'Go to Marketing', section: 'Navigate', keywords: ['marketing','listmonk','email'], to: '/marketing', icon: Mail },
    { id: 'go:blog', label: 'Go to Blog', section: 'Navigate', keywords: ['blog','posts'], to: '/blog', icon: FileText },
    { id: 'go:reports', label: 'Go to Reports', section: 'Navigate', keywords: ['reports','analytics','sales'], to: '/reports', icon: BarChart3 },
    { id: 'go:activity', label: 'Go to Activity', section: 'Navigate', keywords: ['activity','audit log'], to: '/activity', icon: Activity },
    { id: 'go:settings', label: 'Go to Settings', section: 'Navigate', keywords: ['settings','config'], to: '/settings', icon: Settings },
    { id: 'go:staff', label: 'Go to Staff', section: 'Navigate', keywords: ['staff','team','permissions','roles'], to: '/staff', icon: Shield },
    { id: 'go:tax-zones', label: 'Go to Tax zones', section: 'Navigate', keywords: ['tax'], to: '/tax-zones', icon: Receipt },
    { id: 'go:webhooks', label: 'Go to Webhooks', section: 'Navigate', keywords: ['webhooks','events'], to: '/webhooks', icon: Webhook },
    { id: 'go:currency-rates', label: 'Go to Currencies', section: 'Navigate', keywords: ['currencies','fx'], to: '/currency-rates', icon: Coins },

    { id: 'act:new-order', label: 'Create new order', section: 'Create', keywords: ['new','order','draft'], to: '/orders/new', icon: Plus },
    { id: 'act:new-product', label: 'Create new product', section: 'Create', keywords: ['new','product','create'], to: '/products/new', icon: Plus },
    { id: 'act:new-customer', label: 'Create new customer', section: 'Create', keywords: ['new','customer','create'], to: '/customers', icon: Plus },
    { id: 'act:import-tracking', label: 'Import tracking numbers', section: 'Create', keywords: ['import','tracking','csv'], to: '/orders/import-tracking', icon: Upload },
    { id: 'act:abandoned-carts', label: 'View abandoned carts', section: 'Create', keywords: ['abandoned','carts'], to: '/abandoned-carts', icon: ShoppingCart },
  ], []);

  // Group A: local commands filtered by query. Group B: remote search.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // No query — show everything grouped by section, with recent pinned first.
      const recents = recent.map((id) => localCommands.find((c) => c.id === id)).filter(Boolean) as LocalCommand[];
      const others = localCommands.filter((c) => !recent.includes(c.id));
      return [...recents, ...others];
    }
    return localCommands.filter((c) => {
      const blob = `${c.label} ${c.section} ${(c.keywords ?? []).join(' ')}`.toLowerCase();
      return blob.includes(q);
    });
  }, [query, localCommands, recent]);

  // Debounced remote search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) { setSearchData(null); return; }
    let aborted = false;
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.get<SearchResult>(`/search?q=${encodeURIComponent(q)}`);
          if (!aborted) setSearchData(res);
        } catch { if (!aborted) setSearchData(null); }
      })();
    }, 200);
    return () => {
      aborted = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Reset active index when the result set shape changes.
  useEffect(() => { setActive(0); }, [query, open]);

  // Build a flat list of selectable items — local first, then remote. Index
  // by position so the keyboard handler can map active to a concrete action.
  type Selectable =
    | { kind: 'cmd'; cmd: LocalCommand }
    | { kind: 'order'; code: string }
    | { kind: 'product'; id: string; name: string }
    | { kind: 'customer'; id: string; email: string };
  const flat: Selectable[] = useMemo(() => {
    const out: Selectable[] = filtered.map((cmd) => ({ kind: 'cmd', cmd }));
    if (searchData) {
      for (const o of searchData.orders) out.push({ kind: 'order', code: o.code });
      for (const p of searchData.products) out.push({ kind: 'product', id: p.id, name: p.name });
      for (const c of searchData.customers) out.push({ kind: 'customer', id: c.id, email: c.email });
    }
    return out;
  }, [filtered, searchData]);

  // Group counters (for the section headers in the list).
  const counts = useMemo(() => {
    const localCount = filtered.length;
    const orderCount = searchData?.orders.length ?? 0;
    const productCount = searchData?.products.length ?? 0;
    const customerCount = searchData?.customers.length ?? 0;
    return { localCount, orderCount, productCount, customerCount };
  }, [filtered, searchData]);

  // ── actions ────────────────────────────────────────────────────────────
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSearchData(null);
    setActive(0);
    // Restore focus to whatever was focused before we opened — critical for
    // keyboard users coming from a list/table they were navigating.
    requestAnimationFrame(() => restoreFocusRef.current?.focus());
  }, []);

  const runSelectable = useCallback((sel: Selectable) => {
    if (sel.kind === 'cmd') {
      const c = sel.cmd;
      if (c.to) { nav(c.to); remember(c.id); recordEvent('palette-command', c.id); }
      if (c.action) c.action();
      close();
    } else if (sel.kind === 'order') {
      nav(`/orders/${sel.code}`); remember(`go:orders`); recordEvent('palette-search', `order:${sel.code}`); close();
    } else if (sel.kind === 'product') {
      nav(`/products/${sel.id}`); remember(`go:products`); recordEvent('palette-search', `product:${sel.id}`); close();
    } else if (sel.kind === 'customer') {
      nav(`/customers/${sel.id}`); remember(`go:customers`); recordEvent('palette-search', `customer:${sel.id}`); close();
    }
  }, [nav, remember, recordEvent, close]);

  // ── global keyboard: open/close + arrow nav ─────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      // Open on Ctrl/Cmd+K from anywhere (even inside inputs).
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (!open) {
          restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
          setOpen(true);
          recordEvent('palette-opened');
        } else {
          close();
          recordEvent('palette-closed');
        }
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); recordEvent('palette-closed'); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const sel = flat[active];
        if (sel) runSelectable(sel);
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, active, flat, runSelectable, close, recordEvent]);

  // Focus the input when we open; track no-result searches for the metric.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 16);
      return () => clearTimeout(t);
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length >= 2 && searchData && counts.orderCount + counts.productCount + counts.customerCount === 0) {
      recordEvent('palette-no-result', q);
    }
  }, [open, query, searchData, counts.orderCount, counts.productCount, counts.customerCount, recordEvent]);

  if (!open) return null;

  let flatIdx = -1;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 animate-fade-in" onClick={close} aria-hidden="true" />
      <div
        role="dialog" aria-modal="true" aria-label="Command palette"
        className="fixed inset-x-0 top-[10vh] md:top-[12vh] z-50 mx-auto w-full max-w-xl px-3"
      >
        <div className="card overflow-hidden shadow-lg">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-100">
            <Search size={15} className="text-gray-400" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search orders, products, customers, or run a command…"
              aria-label="Command palette search"
              className="flex-1 bg-transparent outline-none text-sm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd className="hidden md:inline text-[10px] font-mono px-1.5 py-0.5 rounded border border-gray-200 text-gray-500">esc</kbd>
          </div>

          <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1.5" role="listbox" aria-label="Command results">
            {flat.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                {query.trim().length >= 2 ? 'No matches' : 'Start typing to search'}
              </div>
            )}

            {counts.localCount > 0 && (
              <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Commands</div>
            )}
            {filtered.map((c) => {
              flatIdx += 1;
              const idx = flatIdx;
              const isActive = idx === active;
              const Icon = c.icon;
              return (
                <button
                  key={c.id}
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => runSelectable({ kind: 'cmd', cmd: c })}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left ${isActive ? 'bg-brand-light text-brand' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  <Icon size={15} className="text-gray-400" aria-hidden="true" />
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-[10px] text-gray-400 uppercase">{c.section}</span>
                </button>
              );
            })}

            {searchData && counts.orderCount > 0 && (
              <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 border-t border-gray-100 mt-1">Orders</div>
            )}
            {searchData?.orders.map((o) => {
              flatIdx += 1;
              const idx = flatIdx;
              const isActive = idx === active;
              return (
                <button
                  key={o.code}
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => runSelectable({ kind: 'order', code: o.code })}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left ${isActive ? 'bg-brand-light text-brand' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  <ShoppingBag size={15} className="text-gray-400" aria-hidden="true" />
                  <span className="font-mono">{o.code}</span>
                  <span className="text-gray-400 truncate flex-1">{o.email ?? ''}</span>
                  <BadgeCheck size={12} className="text-gray-300" aria-hidden="true" />
                </button>
              );
            })}

            {searchData && counts.productCount > 0 && (
              <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 border-t border-gray-100 mt-1">Products</div>
            )}
            {searchData?.products.map((p) => {
              flatIdx += 1;
              const idx = flatIdx;
              const isActive = idx === active;
              return (
                <button
                  key={p.id}
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => runSelectable({ kind: 'product', id: p.id, name: p.name })}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left ${isActive ? 'bg-brand-light text-brand' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  <Package size={15} className="text-gray-400" aria-hidden="true" />
                  <span className="truncate flex-1">{p.name}</span>
                </button>
              );
            })}

            {searchData && counts.customerCount > 0 && (
              <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 border-t border-gray-100 mt-1">Customers</div>
            )}
            {searchData?.customers.map((c) => {
              flatIdx += 1;
              const idx = flatIdx;
              const isActive = idx === active;
              return (
                <button
                  key={c.id}
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => runSelectable({ kind: 'customer', id: c.id, email: c.email })}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left ${isActive ? 'bg-brand-light text-brand' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  <Users size={15} className="text-gray-400" aria-hidden="true" />
                  <span className="truncate flex-1">{c.email}</span>
                </button>
              );
            })}
          </div>

          <div className="border-t border-gray-100 px-3 py-1.5 text-[10px] text-gray-400 flex items-center gap-3">
            <span><kbd className="font-mono">↑↓</kbd> navigate</span>
            <span><kbd className="font-mono">↵</kbd> open</span>
            <span><kbd className="font-mono">esc</kbd> close</span>
            <span className="ml-auto flex items-center gap-1"><ArrowRight size={11} /> {store?.name ?? 'store'}</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** Exposed so tests can mount the palette and assert keyboard behavior
 *  without going through the global shortcut. */
export const __test__ = { flatFromQuery: (q: string, cmds: LocalCommand[]) => {
  const ql = q.trim().toLowerCase();
  if (!ql) return cmds;
  return cmds.filter((c) => `${c.label} ${c.section} ${(c.keywords ?? []).join(' ')}`.toLowerCase().includes(ql));
}};
