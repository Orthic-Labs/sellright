import { Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingBag, Package, Layers, Boxes, Users, Settings, ChevronDown,
  LogOut, Percent, Mail, BarChart3, Activity, Search, HandCoins, FileText, FileUp, ListChecks, Download,
  RotateCcw, Gift, Award, Webhook, Warehouse, Receipt, Coins, Shield, CreditCard, Star, BellRing, Globe, MoreHorizontal, Check,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { api } from '../api';
import { initials } from '../lib/format';
import { ThemeMenu } from '../theme';
import { AppErrorBoundary } from './ErrorBoundary';
import { Loading } from './ui';
import { confirmLeave, useLeaveGuardRoot } from '../redesign/leave-guard';
import { OPEN_PALETTE_EVENT } from './CommandPalette';

type IconType = ComponentType<{ size?: number | string; className?: string }>;
interface NavItem { to: string; label: string; icon: IconType; end?: boolean; count?: 'tofulfil' }
interface NavGroup { id: string; label: string; items: NavItem[]; defaultOpen?: boolean }

// Grouped IA — the navigation should teach the product model in one scan.
const GROUPS: NavGroup[] = [
  { id: 'run', label: 'Run store', defaultOpen: true, items: [
    { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
    { to: '/orders', label: 'Orders', icon: ShoppingBag, count: 'tofulfil' },
    { to: '/subscriptions', label: 'Subscriptions', icon: CreditCard },
    { to: '/returns', label: 'Returns', icon: RotateCcw },
    { to: '/customers', label: 'Customers', icon: Users },
  ]},
  // #376: Vendure had its own Fulfilment section (order-tools); same two tools here.
  { id: 'fulfilment', label: 'Fulfilment', defaultOpen: true, items: [
    { to: '/fulfilment/upload', label: 'CSV Upload', icon: FileUp },
    { to: '/fulfilment/manual', label: 'Manual', icon: ListChecks },
    { to: '/fulfilment/export', label: 'Order Export', icon: Download },
  ] },
  { id: 'catalog', label: 'Catalog', defaultOpen: true, items: [
    { to: '/products', label: 'Products', icon: Package },
    { to: '/collections', label: 'Collections', icon: Layers },
    { to: '/inventory', label: 'Inventory', icon: Boxes },
    { to: '/bulk-stock', label: 'Bulk stock', icon: Boxes },
    { to: '/locations', label: 'Locations', icon: Warehouse },
  ]},
  { id: 'grow', label: 'Grow', items: [
    { to: '/discounts', label: 'Discounts', icon: Percent },
    { to: '/gift-cards', label: 'Gift cards', icon: Gift },
    { to: '/account-credit', label: 'Account Credit', icon: Coins },
    { to: '/loyalty', label: 'Points', icon: Award },
    { to: '/reviews', label: 'Reviews', icon: Star },
    { to: '/affiliates', label: 'Affiliates', icon: HandCoins },
    { to: '/marketing', label: 'Marketing', icon: Mail },
    { to: '/blog', label: 'Blog', icon: FileText },
  ]},
  { id: 'insights', label: 'Insights', items: [
    { to: '/reports', label: 'Reports', icon: BarChart3 },
    { to: '/waitlist', label: 'Waitlist', icon: BellRing },
    { to: '/activity', label: 'Activity', icon: Activity },
  ]},
  { id: 'config', label: 'Configuration', items: [
    { to: '/settings', label: 'Settings', icon: Settings },
    { to: '/settings/payments', label: 'Payments', icon: HandCoins },
    { to: '/settings/email', label: 'Email', icon: Mail },
    { to: '/settings/sheerid', label: 'SheerID', icon: Shield },
    { to: '/settings/seo', label: 'SEO', icon: Globe },
    { to: '/staff', label: 'Staff', icon: Shield },
    { to: '/tax-zones', label: 'Taxes', icon: Receipt },
    { to: '/currency-rates', label: 'Currencies', icon: Coins },
    { to: '/webhooks', label: 'Webhooks', icon: Webhook },
  ]},
];

const ALL_ITEMS = GROUPS.flatMap((g) => g.items);

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
  ['/fulfilment', 'Fulfilment'],
  ['/subscriptions', 'Subscriptions'],
  ['/returns', 'Returns'],
  ['/customers', 'Customers'],
  ['/products', 'Products'],
  ['/collections', 'Collections'],
  ['/inventory', 'Inventory'],
  ['/bulk-stock', 'Bulk stock'],
  ['/locations', 'Locations'],
  ['/discounts', 'Discounts'],
  ['/gift-cards', 'Gift cards'],
  ['/account-credit', 'Account Credit'],
  ['/loyalty', 'Points'],
  ['/reviews', 'Reviews'],
  ['/affiliates', 'Affiliates'],
  ['/marketing', 'Marketing'],
  ['/blog', 'Blog'],
  ['/reports', 'Reports'],
  ['/activity', 'Activity'],
  ['/settings/payments', 'Payments'],
  ['/settings/email', 'Email'],
  ['/settings/sheerid', 'SheerID'],
  ['/settings/seo', 'SEO'],
  ['/waitlist', 'Waitlist'],
  ['/settings', 'Settings'],
  ['/staff', 'Staff'],
  ['/tax-zones', 'Taxes'],
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
      {/* Route pages are lazy chunks (main.tsx): the shell stays up while one loads. */}
      <Suspense fallback={<div className="py-16 grid place-items-center"><Loading label="Loading" /></div>}>
        {children ?? <Outlet />}
      </Suspense>
    </AppErrorBoundary>
  );
}

// Store switcher (#406): sits at the top of the sidebar. Switching is guarded like any other navigation
// when an editor has unsaved changes, and reloads so every query and toast belongs to the new store.
function StoreSwitcher() {
  const { store, stores, setStore } = useAuth();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!store) return null;
  const pick = async (slug: string) => {
    setOpen(false);
    if (slug === store.slug || !(await confirmLeave())) return;
    setStore(slug);
    location.reload();
  };
  return (
    <div className="relative">
      <button ref={btn} className="store" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Switch store">
        <span className="logo">{initials(store.name)}</span>
        <div className="min-w-0"><b className="truncate">{store.name}</b><small className="capitalize">{store.role}</small></div>
        {stores.length > 1 && <ChevronDown size={14} className="chev" aria-hidden="true" />}
      </button>
      {open && stores.length > 1 && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="menu" style={{ left: 10, top: 62, width: 204 }} role="menu">
            {stores.map((s) => (
              <button key={s.slug} role="menuitemradio" aria-checked={s.slug === store.slug} onClick={() => void pick(s.slug)}>
                <span className="truncate">{s.name}</span>
                {s.slug === store.slug && <Check size={14} className="ml-auto" aria-hidden="true" />}
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
    <div className="me">
      <span className="av">{me ? initials(me.email) : '··'}</span>
      <span className="truncate">{me?.email}</span>
      <span className="sp" />
      <div className="relative">
        <button className="iconbtn" style={{ color: 'inherit', width: 24, height: 24 }} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
          <MoreHorizontal size={14} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="menu" style={{ left: 14, bottom: 46 }} role="menu">
              <button role="menuitem" className="dng" onClick={() => void logout()}><LogOut size={14} /> Sign out</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const NAV_KEY = (id: string) => `sr_nav_${id}`;

function NavItems() {
  const loc = useLocation();
  const { store } = useAuth();
  // Group open/closed is remembered per browser profile (per user); the group holding the current page always opens.
  const [openIds, setOpenIds] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of GROUPS) {
      let saved: string | null = null;
      try { saved = localStorage.getItem(NAV_KEY(g.id)); } catch { /* storage blocked: fall back to defaults */ }
      init[g.id] = saved != null ? saved === '1' : !!g.defaultOpen;
    }
    return init;
  });
  const toggle = (id: string, now: boolean) => setOpenIds((m) => {
    try { localStorage.setItem(NAV_KEY(id), now ? '0' : '1'); } catch { /* not persisted */ }
    return { ...m, [id]: !now };
  });
  const { data: counts } = useQuery({
    queryKey: ['orders', 'tab-counts', store?.slug],
    queryFn: () => api.get<Record<string, number>>('/orders/tab-counts?excludeDemo=1'),
    enabled: !!store,
    refetchInterval: 60_000,
  });
  // One highlighted entry: the longest item path that the current path sits under (/settings/payments is
  // Payments, not Settings too; /orders/1002 is Orders, /orders/import-tracking is CSV upload).
  const activeTo = ALL_ITEMS.filter((i) => (i.end ? loc.pathname === i.to : loc.pathname === i.to || loc.pathname.startsWith(i.to + '/')))
    .sort((a, b) => b.to.length - a.to.length)[0]?.to;
  const navRef = useRef<HTMLElement>(null);
  // Keep the current page visible in a long sidebar.
  useEffect(() => { navRef.current?.querySelector('[aria-current=page]')?.scrollIntoView({ block: 'nearest' }); }, [loc.pathname]);

  return (
    <nav ref={navRef} className="navscroll" aria-label="Primary">
      {GROUPS.map((g) => {
        const open = openIds[g.id] || groupContainsPath(g, loc.pathname);
        return (
          <div key={g.id}>
            <button className="grp" aria-expanded={open} onClick={() => toggle(g.id, open)}>
              {g.label}<ChevronDown size={12} aria-hidden="true" />
            </button>
            <div className="gi">
              {g.items.map(({ to, label, icon: Icon, count }) => {
                const n = count ? counts?.[count] : undefined;
                return (
                  <Link key={to} to={to} className="nav" aria-current={activeTo === to ? 'page' : undefined}>
                    <Icon size={15} aria-hidden="true" />{label}
                    {n != null && n > 0 && <span className="ct hot" aria-label={`${n} to fulfil`}>{n}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

export default function Layout() {
  const loc = useLocation();
  const navigate = useNavigate();
  useLeaveGuardRoot(navigate);
  return (
    <div className="app">
      <div className="rd contents">
        <aside className="side" aria-label="Main navigation">
          <StoreSwitcher />
          <NavItems />
          <AccountMenu />
        </aside>
      </div>
      <section className="main">
        <div className="rd contents">
          <header className="top">
            <button className="search" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))} aria-label="Search and commands (Ctrl K)">
              <Search size={14} aria-hidden="true" />Search orders, products, customers<span className="kbd">Ctrl K</span>
            </button>
            <span className="sp" />
            <ThemeMenu />
          </header>
        </div>
        <main key={loc.pathname} className="flex-1 overflow-auto min-h-0 flex flex-col">
          <SectionedOutlet>
            <LegacyFrame />
          </SectionedOutlet>
        </main>
      </section>
    </div>
  );
}

// Pages not yet rebuilt (#406) keep their old padded frame; rebuilt pages mark themselves with
// data-full-bleed routes and fill the main pane edge to edge.
const FULL_BLEED = [/^\/orders\/?$/, /^\/orders\/(?!new$|import-tracking$|tracking-grid$)[^/]+$/, /^\/products\/(?!new$)[^/]+$/, /^\/settings\/payments$/, /^\/discounts(\/.*)?$/];
function LegacyFrame() {
  const loc = useLocation();
  if (FULL_BLEED.some((r) => r.test(loc.pathname))) return <Outlet />;
  return <div className="mx-auto w-full max-w-7xl px-6 py-7"><Outlet /></div>;
}
