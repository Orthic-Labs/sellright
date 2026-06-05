import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutDashboard, ShoppingBag, Package, Layers, Boxes, Users, Settings, ChevronDown, LogOut, Store } from 'lucide-react';
import { useAuth } from '../auth';
import { initials } from '../lib/format';

const NAV = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/orders', label: 'Orders', icon: ShoppingBag },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/collections', label: 'Collections', icon: Layers },
  { to: '/inventory', label: 'Inventory', icon: Boxes },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function StoreSwitcher() {
  const { store, stores, setStore } = useAuth();
  const [open, setOpen] = useState(false);
  if (!store) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50">
        <Store size={15} className="text-brand" />
        <span className="max-w-[140px] truncate">{store.name}</span>
        <ChevronDown size={14} className="text-gray-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1.5 w-60 card p-1">
            {stores.map((s) => (
              <button key={s.slug} onClick={() => { setStore(s.slug); setOpen(false); location.reload(); }}
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

export default function Layout() {
  const { me, logout } = useAuth();
  const loc = useLocation();
  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-gray-200 bg-[#fbfbfa]">
        <div className="flex items-center gap-2 px-5 h-14 border-b border-gray-200">
          <div className="h-6 w-6 rounded bg-brand" />
          <span className="font-semibold tracking-tight">SellRight</span>
        </div>
        <nav className="flex-1 p-3 space-y-0.5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive ? 'bg-white shadow-[0_1px_2px_rgba(0,0,0,0.05)] font-semibold text-ink' : 'text-gray-600 hover:bg-white/70'
                }`
              }>
              <Icon size={17} /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-200">
          <button onClick={() => void logout()} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-white/70">
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex items-center justify-between gap-3 h-14 px-5 border-b border-gray-200 bg-white/80 backdrop-blur">
          <div className="md:hidden font-semibold">SellRight</div>
          <div className="flex-1" />
          <StoreSwitcher />
          <div className="flex items-center gap-2 pl-1">
            <div className="h-8 w-8 rounded-full bg-brand-light text-brand grid place-items-center text-xs font-semibold">
              {me ? initials(me.email) : '··'}
            </div>
          </div>
        </header>
        <main key={loc.pathname} className="flex-1 overflow-auto">
          <div className="mx-auto max-w-6xl px-5 py-7">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
