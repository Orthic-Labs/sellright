import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingBag, Package, Layers, Boxes, Users, Settings, ChevronDown,
  LogOut, Store, Percent, Mail, BarChart3, Activity, Search, HandCoins, FileText,
  RotateCcw, Gift, Webhook, Warehouse, Receipt, Coins, Shield, Menu, X, CreditCard,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { api } from '../api';
import { initials } from '../lib/format';
import { ThemeMenu } from '../theme';
import { AppErrorBoundary } from './ErrorBoundary';

type IconType = ComponentType<{ size?: number | string; className?: string }>;
interface NavItem { to: string; label: string; icon: IconType; end?: boolean }
interface NavGroup { id: string; label: string; items: NavItem[]; defaultOpen?: boolean }

// Grouped IA — the navigation should teach the product model in one scan.
const GROUPS: NavGroup[] = [
  { id: 'run', label: 'Run store', defaultOpen: true, items: [
    { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
    { to: '/orders', label: 'Orders', icon: ShoppingBag },
    { to: '/subscriptions', label: 'Subscriptions', icon: CreditCard },
    { to: '/returns', label: 'Returns', icon: RotateCcw },
    { to: '/customers', label: 'Customers', icon: Users },
  ]},
  { id: 'catalog', label: 'Catalog', defaultOpen: true, items: [
    { to: '/products', label: 'Products', icon: Package },
    { to: '/collections', label: 'Collections', icon: Layers },
    { to: '/inventory', label: 'Inventory', icon: Boxes },
    { to: '/locations', label: 'Locations', icon: Warehouse },
  ]},
  { id: 'grow', label: 'Grow', items: [
    { to: '/discounts', label: 'Discounts', icon: Percent },
    { to: '/gift-cards', label: 'Gift cards', icon: Gift },
    { to: '/affiliates', label: 'Affiliates', icon: HandCoins },
    { to: '/marketing', label: 'Marketing', icon: Mail },
    { to: '/blog', label: 'Blog', icon: FileText },
  ]},
  { id: 'insights', label: 'Insights', items: [
    { to: '/reports', label: 'Reports', icon: BarChart3 },
    { to: '/activity', label: 'Activity', icon: Activity },
  ]},
  { id: 'config', label: 'Configuration', items: [
    { to: '/settings', label: 'Settings', icon: Settings },
    { to: '/staff', label: 'Staff', icon: Shield },
    { to: '/tax-zones', label: 'Tax zones', icon: Receipt },
    { to: '/currency-rates', label: 'Currencies', icon: Coins },
    { to: '/webhooks', label: 'Webhooks', icon: Webhook },
  ]},
];

const groupContainsPath = (g: NavGroup, path: string) =>
  g.items.some((i) => (i.end ? path === i.to : path === i.to || path.startsWith(i.to + '/')));

/**
 * Map a path to its admin section. Order matters — first match wins. The
 * sections correspond to the major groups in DISPATCH.md §3a row FE-8:
 * orders, products, customers, settings. Anything that doesn't match falls
 * through to the root boundary (which still catches, just with generic copy).
 */
const SECTION_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['/orders', 'Orders'],
  ['/subscriptions', 'Subscriptions'],
  ['/returns', 'Returns'],
  ['/customers', 'Customers'],
  ['/products', 'Products'],
  ['/collections', 'Collections'],
  ['/inventory', 'Inventory'],
  ['/locations', 'Locations'],
  ['/discounts', 'Discounts'],
  ['/gift-cards', 'Gift cards'],
  ['/affiliates', 'Affiliates'],
  ['/marketing', 'Marketing'],
  ['/blog', 'Blog'],
  ['/reports', 'Reports'],
  ['/activity', 'Activity'],
  ['/settings', 'Settings'],
  ['/staff', 'Staff'],
  ['/tax-zones', 'Tax zones'],
  ['/currency-rates', 'Currencies'],
  ['/webhooks', 'Webhooks'],
];

function sectionLabelFor(path: string): string {
  for (const [prefix, label] of SECTION_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) return label;
  }
  return '';
}

/**
 * Wraps <Outlet /> in a per-section error boundary keyed by pathname. A render
 * error in /admin/orders shows a fallback there while /admin/products still
 * loads normally. Keying by pathname means React unmounts/remounts the child
 * on navigation, which gives each section its own boundary instance.
 */
function SectionedOutlet({ children }: { children?: ReactNode }) {
  const loc = useLocation();
  const label = sectionLabelFor(loc.pathname);
  return (
    <AppErrorBoundary key={loc.pathname} sectionLabel={label || undefined}>
      {children ?? <Outlet />}
    </AppErrorBoundary>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const { data } = useQuery({
    queryKey: ['global-search', q],
    queryFn: () => api.get<{ orders: any[]; products: any[]; customers: any[] }>(`/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 1,
  });
  const go = (path: string) => { setQ(''); setOpen(false); nav(path); };
  const has = data && (data.orders.length || data.products.length || data.customers.length);
  return (
    <div className="relative w-72 max-w-[42vw]">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
      <input className="input pl-9 py-1.5" placeholder="Search orders, products, customers" aria-label="Search orders, products, and customers" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      {open && q.trim().length > 1 && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1.5 w-80 right-0 card p-1 max-h-96 overflow-auto text-sm animate-fade-in" role="listbox">
            {!has && <div className="px-3 py-2 text-gray-400">No matches</div>}
            {data?.orders.map((o) => <button key={o.code} className="menu-item" onClick={() => go(`/orders/${o.code}`)}><ShoppingBag size={14} className="text-gray-400" /><span className="font-mono">{o.code}</span> <span className="text-gray-400 truncate">{o.email ?? ''}</span></button>)}
            {data?.products.map((p) => <button key={p.id} className="menu-item" onClick={() => go(`/products/${p.id}`)}><Package size={14} className="text-gray-400" /><span className="truncate">{p.name}</span></button>)}
            {data?.customers.map((c) => <button key={c.id} className="menu-item" onClick={() => go(`/customers/${c.id}`)}><Users size={14} className="text-gray-400" /><span className="truncate">{c.email}</span></button>)}
          </div>
        </>
      )}
    </div>
  );
}

function StoreSwitcher() {
  const { store, stores, setStore } = useAuth();
  const [open, setOpen] = useState(false);
  if (!store) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-gray-300 bg-surface px-3 py-1.5 text-sm font-medium hover:bg-gray-50">
        <Store size={15} className="text-brand" aria-hidden="true" />
        <span className="max-w-[140px] truncate">{store.name}</span>
        <ChevronDown size={14} className="text-gray-400" aria-hidden="true" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1.5 w-60 card p-1 animate-fade-in" role="menu">
            {stores.map((s) => (
              <button key={s.slug} role="menuitem" onClick={() => { setStore(s.slug); setOpen(false); location.reload(); }}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-gray-50 ${s.slug === store.slug ? 'font-semibold' : ''}`}>
                <span className="truncate">{s.name}</span>
                <span className="text-[11px] uppercase text-gray-400">{s.role}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AccountMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu"
        className="grid h-8 w-8 place-items-center rounded-full bg-brand-light text-brand text-xs font-semibold hover:ring-2 hover:ring-brand/20">
        {me ? initials(me.email) : '··'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1.5 w-56 card p-1 animate-fade-in" role="menu">
            <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-100 mb-1 truncate">{me?.email}</div>
            <button role="menuitem" className="menu-item-danger" onClick={() => void logout()}><LogOut size={15} /> Sign out</button>
          </div>
        </>
      )}
    </div>
  );
}

// Store-first identity block — generated initials mark + store name + product label.
function StoreMark({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-brand-on text-xs font-bold">
        {initials(name)}
      </div>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold">{name}</div>
        <div className="text-[11px] text-shell-muted">SellRight admin</div>
      </div>
    </div>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const loc = useLocation();
  // Group open/closed persists per group; a group containing the active route is always shown open.
  const [openIds, setOpenIds] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of GROUPS) {
      const saved = localStorage.getItem(`sr_nav_${g.id}`);
      init[g.id] = saved != null ? saved === '1' : !!g.defaultOpen;
    }
    return init;
  });
  const toggle = (id: string) => setOpenIds((m) => { const v = !m[id]; localStorage.setItem(`sr_nav_${id}`, v ? '1' : '0'); return { ...m, [id]: v }; });

  return (
    <nav className="flex-1 overflow-y-auto p-3 space-y-1" aria-label="Primary">
      {GROUPS.map((g) => {
        const hasActive = groupContainsPath(g, loc.pathname);
        const open = openIds[g.id] || hasActive;
        return (
          <div key={g.id}>
            <button onClick={() => toggle(g.id)} aria-expanded={open}
              className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-shell-muted hover:text-shell-text">
              {g.label}
              <ChevronDown size={13} className={`transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
            </button>
            {open && (
              <div className="mt-0.5 space-y-0.5">
                {g.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink key={to} to={to} end={end} onClick={onNavigate}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                        isActive ? 'bg-shell-active font-semibold text-shell-active-text' : 'text-shell-muted hover:bg-shell-surface hover:text-shell-text'
                      }`}>
                    <Icon size={17} /> {label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export default function Layout() {
  const { store, logout } = useAuth();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const storeName = store?.name ?? 'Store';

  // Close the mobile drawer on route change and on Escape.
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-shell-border bg-shell text-shell-text">
        <div className="flex items-center px-4 h-14 border-b border-shell-border">
          <StoreMark name={storeName} />
        </div>
        <NavItems />
        <div className="p-3 border-t border-shell-border">
          <button onClick={() => void logout()} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-shell-muted hover:bg-shell-surface hover:text-shell-text">
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={() => setDrawer(false)} aria-hidden="true" />
          <aside className="relative flex w-72 max-w-[80vw] flex-col bg-shell text-shell-text shadow-xl animate-drawer-in" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="flex items-center justify-between px-4 h-14 border-b border-shell-border">
              <StoreMark name={storeName} />
              <button onClick={() => setDrawer(false)} aria-label="Close navigation" className="grid h-8 w-8 place-items-center rounded-lg text-shell-muted hover:bg-shell-surface hover:text-shell-text"><X size={18} /></button>
            </div>
            <NavItems onNavigate={() => setDrawer(false)} />
            <div className="p-3 border-t border-shell-border">
              <button onClick={() => void logout()} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-shell-muted hover:bg-shell-surface hover:text-shell-text">
                <LogOut size={16} /> Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex items-center gap-3 h-14 px-4 md:px-5 border-b border-gray-200 bg-surface/80 backdrop-blur">
          {/* Mobile: menu + store name */}
          <button className="md:hidden grid h-9 w-9 place-items-center rounded-lg text-gray-600 hover:bg-gray-100" aria-label="Open navigation" onClick={() => setDrawer(true)}>
            <Menu size={20} />
          </button>
          <span className="md:hidden truncate text-sm font-semibold">{storeName}</span>

          {/* Desktop search */}
          <div className="hidden md:block"><GlobalSearch /></div>

          <div className="flex-1" />
          <ThemeMenu />
          <StoreSwitcher />
          <AccountMenu />
        </header>
        <main key={loc.pathname} className="flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl px-4 md:px-6 py-6 md:py-7">
            <SectionedOutlet />
          </div>
        </main>
      </div>
    </div>
  );
}
