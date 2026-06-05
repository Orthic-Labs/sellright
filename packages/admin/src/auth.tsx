import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, auth, type Me, type StoreAccess } from './api';

interface AuthState {
  loading: boolean;
  me: Me | null;
  store: StoreAccess | null;
  stores: StoreAccess[];
  setStore: (slug: string) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [storeSlug, setStoreSlug] = useState<string | null>(auth.store);

  async function refresh() {
    if (!auth.token) { setMe(null); setLoading(false); return; }
    try {
      const data = await api.get<Me>('/me');
      setMe(data);
      const valid = data.stores.find((s) => s.slug === auth.store) ?? data.stores[0];
      if (valid) { auth.store = valid.slug; setStoreSlug(valid.slug); }
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, []);

  function setStore(slug: string) { auth.store = slug; setStoreSlug(slug); }

  async function logout() {
    try { await api.post('/logout'); } catch { /* ignore */ }
    auth.token = null; auth.store = null;
    setMe(null); setStoreSlug(null);
    location.assign('/login');
  }

  const store = me?.stores.find((s) => s.slug === storeSlug) ?? me?.stores[0] ?? null;

  return (
    <Ctx.Provider value={{ loading, me, store, stores: me?.stores ?? [], setStore, refresh, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
