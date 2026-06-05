import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { PageHeader, Loading, ErrorNote, Spinner, Badge } from '../components/ui';

const PROVIDERS = ['cod', 'manual', 'stripe', 'paypal', 'nmi', 'sezzle'];

export default function SettingsPage() {
  const { me, store, logout } = useAuth();
  const qc = useQueryClient();
  const sk = ['settings-store', store?.slug];
  const { data: cfg, isLoading } = useQuery({ queryKey: sk, queryFn: () => api.get<any>('/settings/store') });
  const ship = useQuery({ queryKey: ['shipping', store?.slug], queryFn: () => api.get<{ items: any[] }>('/shipping-methods') });
  const staff = useQuery({ queryKey: ['staff', store?.slug], queryFn: () => api.get<{ items: any[] }>('/staff') });

  const [store2, setStore2] = useState<{ name: string; taxRate: string } | null>(null);
  const saveStore = useMutation({ mutationFn: () => api.patch('/settings/store', { name: store2!.name, taxRate: Math.round(parseFloat(store2!.taxRate || '0') * 100) }), onSuccess: () => { setStore2(null); qc.invalidateQueries({ queryKey: sk }); } });
  const togglePay = useMutation({ mutationFn: (p: { k: string; v: boolean }) => api.patch('/settings/payments', { [p.k]: p.v }), onSuccess: () => qc.invalidateQueries({ queryKey: sk }) });
  const [gid, setGid] = useState<string | null>(null);
  const saveGoogle = useMutation({ mutationFn: () => api.patch('/settings/google', { clientId: gid }), onSuccess: () => { setGid(null); qc.invalidateQueries({ queryKey: sk }); } });

  const [sm, setSm] = useState<{ code: string; name: string; rate: string } | null>(null);
  const addShip = useMutation({ mutationFn: () => api.post('/shipping-methods', { code: sm!.code, name: sm!.name, calculator: { flat: Math.round(parseFloat(sm!.rate || '0') * 100) } }), onSuccess: () => { setSm(null); ship.refetch(); } });
  const delShip = useMutation({ mutationFn: (id: string) => api.del(`/shipping-methods/${id}`), onSuccess: () => ship.refetch() });

  // ── 2FA ──
  const tfa = useQuery({ queryKey: ['2fa', me?.email], queryFn: () => api.get<{ enabled: boolean }>('/2fa') });
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const startSetup = useMutation({ mutationFn: () => api.post<{ secret: string; otpauthUri: string }>('/2fa/setup'), onSuccess: (r) => setSetup(r) });
  const enable2fa = useMutation({ mutationFn: () => api.post('/2fa/enable', { secret: setup!.secret, code }), onSuccess: () => { setSetup(null); setCode(''); tfa.refetch(); } });
  const disable2fa = useMutation({ mutationFn: () => api.post('/2fa/disable', { code }), onSuccess: () => { setCode(''); tfa.refetch(); } });

  const [inv, setInv] = useState<{ email: string; role: string; password: string } | null>(null);
  const addStaff = useMutation({ mutationFn: () => api.post('/staff', inv), onSuccess: () => { setInv(null); staff.refetch(); } });
  const setRole = useMutation({ mutationFn: (p: { id: string; role: string }) => api.patch(`/staff/${p.id}`, { role: p.role }), onSuccess: () => staff.refetch() });
  const delStaff = useMutation({ mutationFn: (id: string) => api.del(`/staff/${id}`), onSuccess: () => staff.refetch() });

  if (isLoading || !cfg) return <Loading />;
  const canManage = store?.role === 'owner' || store?.role === 'manager';
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="card p-5"><h2 className="text-sm font-semibold mb-3">{title}</h2>{children}</div>
  );

  return (
    <>
      <PageHeader title="Settings" subtitle={store?.name} />
      <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Store & tax">
          {store2 ? (
            <div className="space-y-3">
              <div><label className="label">Name</label><input className="input" value={store2.name} onChange={(e) => setStore2({ ...store2, name: e.target.value })} /></div>
              <div className="max-w-[10rem]"><label className="label">Tax rate %</label><input className="input" inputMode="decimal" value={store2.taxRate} onChange={(e) => setStore2({ ...store2, taxRate: e.target.value })} /></div>
              <div className="flex gap-2"><button className="btn-primary" disabled={saveStore.isPending} onClick={() => saveStore.mutate()}>{saveStore.isPending ? <Spinner className="text-white" /> : 'Save'}</button><button className="btn-ghost" onClick={() => setStore2(null)}>Cancel</button></div>
            </div>
          ) : (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Name</dt><dd className="font-medium">{cfg.name}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Currency</dt><dd className="font-medium">{cfg.currency}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Tax rate</dt><dd className="font-medium">{(cfg.taxRate / 100).toFixed(2)}%</dd></div>
              {canManage && <button className="btn-ghost mt-2" onClick={() => setStore2({ name: cfg.name, taxRate: (cfg.taxRate / 100).toFixed(2) })}>Edit</button>}
            </dl>
          )}
        </Section>

        <Section title="Payment providers">
          <div className="space-y-2">
            {PROVIDERS.map((p) => (
              <label key={p} className="flex items-center justify-between text-sm py-1">
                <span className="capitalize">{p}{(p === 'stripe' || p === 'paypal' || p === 'nmi' || p === 'sezzle') && <span className="text-xs text-gray-400"> (needs keys)</span>}</span>
                <input type="checkbox" className="h-4 w-4 accent-brand" disabled={!canManage || togglePay.isPending} checked={!!cfg.payments?.[p]} onChange={(e) => togglePay.mutate({ k: p, v: e.target.checked })} />
              </label>
            ))}
          </div>
        </Section>

        <Section title="Customer sign-in (Google)">
          <p className="text-xs text-gray-500 mb-2">Paste your Google OAuth <b>client ID</b> to enable “Sign in with Google” on the storefront. (Verification happens server-side against this ID.)</p>
          {gid !== null ? (
            <div className="flex items-end gap-2">
              <input className="input font-mono text-xs" value={gid} onChange={(e) => setGid(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" />
              <button className="btn-primary" disabled={saveGoogle.isPending} onClick={() => saveGoogle.mutate()}>{saveGoogle.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
              <button className="btn-ghost" onClick={() => setGid(null)}>Cancel</button>
            </div>
          ) : (
            <div className="flex items-center justify-between text-sm">
              <span className="font-mono text-xs text-gray-600">{cfg.googleClientId ? `${String(cfg.googleClientId).slice(0, 24)}…` : <span className="text-gray-400">not set</span>}</span>
              {canManage && <button className="btn-ghost" onClick={() => setGid(cfg.googleClientId ?? '')}>{cfg.googleClientId ? 'Change' : 'Set'}</button>}
            </div>
          )}
        </Section>

        <Section title="Shipping methods">
          <div className="space-y-1 mb-3">
            {ship.data?.items.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-sm py-1">
                <span>{m.name} <span className="text-gray-400 text-xs">{m.code}</span></span>
                <span className="flex items-center gap-2"><Badge value={m.enabled ? 'active' : 'draft'} />{canManage && <button className="text-gray-300 hover:text-red-600" onClick={() => delShip.mutate(m.id)}>✕</button>}</span>
              </div>
            ))}
            {ship.data?.items.length === 0 && <div className="text-sm text-gray-400">None yet.</div>}
          </div>
          {canManage && (sm ? (
            <div className="flex items-end gap-2">
              <div><label className="label">Code</label><input className="input w-24" value={sm.code} onChange={(e) => setSm({ ...sm, code: e.target.value })} /></div>
              <div><label className="label">Name</label><input className="input w-32" value={sm.name} onChange={(e) => setSm({ ...sm, name: e.target.value })} /></div>
              <div><label className="label">Rate</label><input className="input w-20" value={sm.rate} onChange={(e) => setSm({ ...sm, rate: e.target.value })} placeholder="0.00" /></div>
              <button className="btn-primary" disabled={addShip.isPending} onClick={() => addShip.mutate()}>Add</button>
            </div>
          ) : <button className="btn-ghost" onClick={() => setSm({ code: '', name: '', rate: '' })}>+ Add method</button>)}
        </Section>

        <Section title="Staff & permissions">
          {!canManage ? <div className="text-sm text-gray-400">Only owners/managers can manage staff.</div> : (
            <>
              <div className="space-y-1 mb-3">
                {staff.data?.items.map((u) => (
                  <div key={u.adminUserId} className="flex items-center justify-between text-sm py-1">
                    <span>{u.email}{u.isYou && <span className="text-xs text-gray-400"> (you)</span>}</span>
                    <span className="flex items-center gap-2">
                      <select className="input py-1 text-xs w-28" value={u.role} disabled={u.isYou} onChange={(e) => setRole.mutate({ id: u.adminUserId, role: e.target.value })}>
                        {['owner', 'manager', 'staff', 'read_only'].map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      {!u.isYou && <button className="text-gray-300 hover:text-red-600" onClick={() => delStaff.mutate(u.adminUserId)}>✕</button>}
                    </span>
                  </div>
                ))}
              </div>
              {inv ? (
                <div className="space-y-2">
                  <div className="flex gap-2"><input className="input" placeholder="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /><select className="input w-28" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{['staff', 'manager', 'owner', 'read_only'].map((r) => <option key={r}>{r}</option>)}</select></div>
                  <input className="input" type="password" placeholder="initial password (min 8)" value={inv.password} onChange={(e) => setInv({ ...inv, password: e.target.value })} />
                  {addStaff.error && <ErrorNote message={(addStaff.error as Error).message} />}
                  <div className="flex gap-2"><button className="btn-primary" disabled={addStaff.isPending} onClick={() => addStaff.mutate()}>Add</button><button className="btn-ghost" onClick={() => setInv(null)}>Cancel</button></div>
                </div>
              ) : <button className="btn-ghost" onClick={() => setInv({ email: '', role: 'staff', password: '' })}>+ Add staff</button>}
            </>
          )}
        </Section>

        <Section title="Two-factor authentication">
          {tfa.data?.enabled ? (
            <div className="space-y-2">
              <div className="text-sm text-emerald-700">✓ 2FA is on for your account.</div>
              <input className="input tracking-widest text-center max-w-[10rem]" inputMode="numeric" maxLength={6} placeholder="code to disable" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              {disable2fa.error && <ErrorNote message={(disable2fa.error as Error).message} />}
              <button className="btn-danger" disabled={code.length !== 6 || disable2fa.isPending} onClick={() => disable2fa.mutate()}>{disable2fa.isPending ? <Spinner /> : 'Disable 2FA'}</button>
            </div>
          ) : setup ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-600">Add this secret to your authenticator app (Google Authenticator, Authy, 1Password), then enter the 6-digit code:</p>
              <div className="font-mono text-xs bg-gray-50 border border-gray-200 rounded p-2 break-all">{setup.secret}</div>
              <a className="text-xs text-brand hover:underline break-all" href={setup.otpauthUri}>otpauth link</a>
              <input className="input tracking-widest text-center max-w-[10rem]" inputMode="numeric" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              {enable2fa.error && <ErrorNote message={(enable2fa.error as Error).message} />}
              <div className="flex gap-2"><button className="btn-primary" disabled={code.length !== 6 || enable2fa.isPending} onClick={() => enable2fa.mutate()}>{enable2fa.isPending ? <Spinner className="text-white" /> : 'Enable'}</button><button className="btn-ghost" onClick={() => { setSetup(null); setCode(''); }}>Cancel</button></div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-gray-500">Protect your account with an authenticator-app code at sign-in.</p>
              <button className="btn-ghost" disabled={startSetup.isPending} onClick={() => startSetup.mutate()}>{startSetup.isPending ? <Spinner /> : 'Enable 2FA'}</button>
            </div>
          )}
        </Section>

        <Section title="Account">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Email</dt><dd className="font-medium">{me?.email}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Your role</dt><dd className="font-medium capitalize">{store?.role}</dd></div>
          </dl>
          <button className="btn-ghost mt-3" onClick={() => void logout()}>Sign out</button>
        </Section>
      </div>
    </>
  );
}
