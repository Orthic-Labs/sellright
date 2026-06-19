import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Store, CreditCard, Truck, Receipt, LogIn, ShieldCheck, UsersRound, UserCircle, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { PageHeader, Loading, Spinner, Badge, FormSection, Field, InlineAlert } from '../components/ui';

const PROVIDERS = ['cod', 'manual', 'stripe', 'paypal', 'nmi', 'sezzle'];
const NEEDS_KEYS = new Set(['stripe', 'paypal', 'nmi', 'sezzle']);

type SectionId = 'store' | 'payments' | 'shipping' | 'taxes' | 'signin' | 'security' | 'team' | 'account';
const NAV: { group: string; items: { id: SectionId; label: string; icon: typeof Store }[] }[] = [
  { group: 'Store', items: [
    { id: 'store', label: 'Store profile', icon: Store },
    { id: 'payments', label: 'Payments', icon: CreditCard },
    { id: 'shipping', label: 'Shipping', icon: Truck },
    { id: 'taxes', label: 'Taxes', icon: Receipt },
    { id: 'signin', label: 'Customer sign-in', icon: LogIn },
  ]},
  { group: 'Account & access', items: [
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'team', label: 'Team', icon: UsersRound },
    { id: 'account', label: 'Account', icon: UserCircle },
  ]},
];

export default function SettingsPage() {
  const { me, store, logout } = useAuth();
  const qc = useQueryClient();
  const [section, setSection] = useState<SectionId>('store');
  const sk = ['settings-store', store?.slug];
  const { data: cfg, isLoading } = useQuery({ queryKey: sk, queryFn: () => api.get<any>('/settings/store') });
  const ship = useQuery({ queryKey: ['shipping', store?.slug], queryFn: () => api.get<{ items: any[] }>('/shipping-methods') });
  const staff = useQuery({ queryKey: ['staff', store?.slug], queryFn: () => api.get<{ items: any[] }>('/staff') });

  const [store2, setStore2] = useState<{ name: string } | null>(null);
  const saveStore = useMutation({ mutationFn: () => api.patch('/settings/store', { name: store2!.name }), onSuccess: () => { setStore2(null); qc.invalidateQueries({ queryKey: sk }); } });
  const [tax, setTax] = useState<string | null>(null);
  const saveTax = useMutation({ mutationFn: () => api.patch('/settings/store', { taxRate: Math.round(parseFloat(tax || '0') * 100) }), onSuccess: () => { setTax(null); qc.invalidateQueries({ queryKey: sk }); } });
  const togglePay = useMutation({ mutationFn: (p: { k: string; v: boolean }) => api.patch('/settings/payments', { [p.k]: p.v }), onSuccess: () => qc.invalidateQueries({ queryKey: sk }) });
  const setStripeMode = useMutation({ mutationFn: (mode: 'test' | 'live') => api.patch('/settings/payments/stripe-mode', { mode }), onSuccess: () => qc.invalidateQueries({ queryKey: sk }) });
  const [gid, setGid] = useState<string | null>(null);
  const saveGoogle = useMutation({ mutationFn: () => api.patch('/settings/google', { clientId: gid }), onSuccess: () => { setGid(null); qc.invalidateQueries({ queryKey: sk }); } });

  const [sm, setSm] = useState<{ code: string; name: string; rate: string } | null>(null);
  const addShip = useMutation({ mutationFn: () => api.post('/shipping-methods', { code: sm!.code, name: sm!.name, calculator: { flat: Math.round(parseFloat(sm!.rate || '0') * 100) } }), onSuccess: () => { setSm(null); ship.refetch(); } });
  const delShip = useMutation({ mutationFn: (id: string) => api.del(`/shipping-methods/${id}`), onSuccess: () => ship.refetch() });

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

  return (
    <>
      <PageHeader title="Settings" subtitle={store?.name} />
      <div className="grid lg:grid-cols-[200px_1fr] gap-6">
        {/* Section nav — sticky on desktop, horizontal scroll on mobile. */}
        <nav className="lg:sticky lg:top-2 self-start -mx-1 lg:mx-0 overflow-x-auto" aria-label="Settings sections">
          <div className="flex lg:flex-col gap-1 min-w-max lg:min-w-0">
            {NAV.map((g) => (
              <div key={g.group} className="lg:mb-2 flex lg:flex-col gap-1">
                <div className="hidden lg:block px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{g.group}</div>
                {g.items.map(({ id, label, icon: Icon }) => (
                  <button key={id} onClick={() => setSection(id)} aria-current={section === id ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors ${section === id ? 'bg-brand-light text-brand font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                    <Icon size={16} /> {label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>

        <div className="space-y-5 min-w-0">
          {section === 'store' && (
            <FormSection title="Store profile" description="Your store's public name and base currency."
              actions={store2 && <>
                <button className="btn-ghost" onClick={() => setStore2(null)}>Cancel</button>
                <button className="btn-primary" disabled={saveStore.isPending || !store2.name.trim()} onClick={() => saveStore.mutate()}>{saveStore.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
              </>}>
              {store2 ? (
                <Field label="Store name" htmlFor="s-name"><input id="s-name" className="input max-w-md" value={store2.name} onChange={(e) => setStore2({ name: e.target.value })} /></Field>
              ) : (
                <dl className="space-y-2.5 text-sm">
                  <div className="flex justify-between max-w-md"><dt className="text-gray-500">Name</dt><dd className="font-medium">{cfg.name}</dd></div>
                  <div className="flex justify-between max-w-md"><dt className="text-gray-500">Currency</dt><dd className="font-medium">{cfg.currency}</dd></div>
                </dl>
              )}
              {!store2 && canManage && <button className="btn-ghost btn-sm" onClick={() => setStore2({ name: cfg.name })}>Edit profile</button>}
            </FormSection>
          )}

          {section === 'payments' && (
            <FormSection title="Payment providers" description="Enable the methods customers can pay with at checkout.">
              <div className="divide-y divide-gray-100">
                {PROVIDERS.map((p) => {
                  const on = !!cfg.payments?.[p];
                  return (
                    <div key={p} className="flex items-center justify-between py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="capitalize text-sm font-medium">{p}</span>
                        {on ? <Badge value="active" label="Enabled" /> : NEEDS_KEYS.has(p) ? <Badge tone="neutral" value="keys" label="Needs keys" /> : <Badge tone="neutral" value="off" label="Off" />}
                      </div>
                      <label className="inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="h-4 w-4 accent-brand" disabled={!canManage || togglePay.isPending} checked={on} onChange={(e) => togglePay.mutate({ k: p, v: e.target.checked })} />
                      </label>
                    </div>
                  );
                })}
              </div>
              {!!cfg.payments?.stripe && (
                <div className="pt-4 border-t border-gray-100 mt-4">
                  <Field label="Stripe mode" hint="Choose which env key set Stripe uses for payment intents, refunds, and webhook verification.">
                    <select
                      className="input w-40"
                      disabled={!canManage || setStripeMode.isPending}
                      value={cfg.stripeMode ?? 'test'}
                      onChange={(e) => setStripeMode.mutate(e.target.value as 'test' | 'live')}
                    >
                      <option value="test">test</option>
                      <option value="live">live</option>
                    </select>
                  </Field>
                </div>
              )}
              {!canManage && <InlineAlert tone="neutral">Only owners and managers can change payment settings.</InlineAlert>}
            </FormSection>
          )}

          {section === 'shipping' && (
            <FormSection title="Shipping methods" description="Flat-rate methods offered at checkout."
              actions={canManage && !sm && <button className="btn-ghost btn-sm" onClick={() => setSm({ code: '', name: '', rate: '' })}><Plus size={14} /> Add method</button>}>
              <div className="divide-y divide-gray-100">
                {ship.data?.items.map((m) => (
                  <div key={m.id} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="font-medium">{m.name} <span className="text-gray-400 text-xs font-normal">{m.code}</span></span>
                    <span className="flex items-center gap-2"><Badge value={m.enabled ? 'active' : 'draft'} />{canManage && <button className="text-gray-300 hover:text-danger" aria-label="Delete method" onClick={() => delShip.mutate(m.id)}><Trash2 size={15} /></button>}</span>
                  </div>
                ))}
                {ship.data?.items.length === 0 && !sm && <div className="text-sm text-gray-400 py-2">No shipping methods yet.</div>}
              </div>
              {sm && (
                <div className="flex flex-wrap items-end gap-2 pt-1">
                  <Field label="Code"><input className="input w-24" value={sm.code} onChange={(e) => setSm({ ...sm, code: e.target.value })} /></Field>
                  <Field label="Name"><input className="input w-40" value={sm.name} onChange={(e) => setSm({ ...sm, name: e.target.value })} /></Field>
                  <Field label="Rate"><input className="input w-24 tnum" value={sm.rate} onChange={(e) => setSm({ ...sm, rate: e.target.value })} placeholder="0.00" /></Field>
                  <button className="btn-primary" disabled={addShip.isPending || !sm.code || !sm.name} onClick={() => addShip.mutate()}>{addShip.isPending ? <Spinner className="text-white" /> : 'Add'}</button>
                  <button className="btn-ghost" onClick={() => setSm(null)}>Cancel</button>
                </div>
              )}
            </FormSection>
          )}

          {section === 'taxes' && (
            <FormSection title="Taxes" description="A single base tax rate applied to orders."
              actions={tax !== null && <>
                <button className="btn-ghost" onClick={() => setTax(null)}>Cancel</button>
                <button className="btn-primary" disabled={saveTax.isPending} onClick={() => saveTax.mutate()}>{saveTax.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
              </>}>
              {tax !== null ? (
                <Field label="Tax rate %" htmlFor="s-tax" hint="Percentage applied to taxable order subtotals."><input id="s-tax" className="input max-w-[10rem] tnum" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} /></Field>
              ) : (
                <>
                  <dl className="space-y-2.5 text-sm"><div className="flex justify-between max-w-md"><dt className="text-gray-500">Base tax rate</dt><dd className="font-medium tnum">{(cfg.taxRate / 100).toFixed(2)}%</dd></div></dl>
                  {canManage && <button className="btn-ghost btn-sm" onClick={() => setTax((cfg.taxRate / 100).toFixed(2))}>Edit rate</button>}
                </>
              )}
            </FormSection>
          )}

          {section === 'signin' && (
            <FormSection title="Customer sign-in (Google)" description="Let customers sign in to the storefront with Google."
              actions={gid !== null && <>
                <button className="btn-ghost" onClick={() => setGid(null)}>Cancel</button>
                <button className="btn-primary" disabled={saveGoogle.isPending} onClick={() => saveGoogle.mutate()}>{saveGoogle.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
              </>}>
              <p className="text-xs text-gray-500">Paste your Google OAuth <b>client ID</b>. Verification happens server-side against this ID.</p>
              {gid !== null ? (
                <Field label="Google client ID" htmlFor="s-gid"><input id="s-gid" className="input font-mono text-xs max-w-lg" value={gid} onChange={(e) => setGid(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" /></Field>
              ) : (
                <div className="flex items-center justify-between text-sm max-w-lg">
                  <span className="font-mono text-xs text-gray-600">{cfg.googleClientId ? `${String(cfg.googleClientId).slice(0, 28)}…` : <span className="text-gray-400">Not configured</span>}</span>
                  {canManage && <button className="btn-ghost btn-sm" onClick={() => setGid(cfg.googleClientId ?? '')}>{cfg.googleClientId ? 'Change' : 'Set up'}</button>}
                </div>
              )}
            </FormSection>
          )}

          {section === 'security' && (
            <FormSection title="Two-factor authentication" description="Protect your account with an authenticator-app code at sign-in.">
              {tfa.data?.enabled ? (
                <>
                  <InlineAlert tone="positive" title="2FA is on for your account.">Enter a current code to turn it off.</InlineAlert>
                  <Field label="Authenticator code"><input className="input tracking-widest text-center max-w-[10rem] tnum" inputMode="numeric" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
                  {disable2fa.error && <InlineAlert tone="critical">{(disable2fa.error as Error).message}</InlineAlert>}
                  <button className="btn-danger" disabled={code.length !== 6 || disable2fa.isPending} onClick={() => disable2fa.mutate()}>{disable2fa.isPending ? <Spinner /> : 'Disable 2FA'}</button>
                </>
              ) : setup ? (
                <>
                  <p className="text-sm text-gray-600">Add this secret to your authenticator app, then enter the 6-digit code.</p>
                  <div className="font-mono text-xs bg-gray-50 border border-gray-200 rounded p-2 break-all max-w-lg">{setup.secret}</div>
                  <a className="text-xs text-brand hover:underline break-all" href={setup.otpauthUri}>otpauth link</a>
                  <Field label="Verification code"><input className="input tracking-widest text-center max-w-[10rem] tnum" inputMode="numeric" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
                  {enable2fa.error && <InlineAlert tone="critical">{(enable2fa.error as Error).message}</InlineAlert>}
                  <div className="flex gap-2"><button className="btn-primary" disabled={code.length !== 6 || enable2fa.isPending} onClick={() => enable2fa.mutate()}>{enable2fa.isPending ? <Spinner className="text-white" /> : 'Enable'}</button><button className="btn-ghost" onClick={() => { setSetup(null); setCode(''); }}>Cancel</button></div>
                </>
              ) : (
                <button className="btn-ghost" disabled={startSetup.isPending} onClick={() => startSetup.mutate()}>{startSetup.isPending ? <Spinner /> : 'Enable 2FA'}</button>
              )}
            </FormSection>
          )}

          {section === 'team' && (
            <FormSection title="Team & permissions" description="People who can access this store's admin."
              actions={canManage && !inv && <button className="btn-ghost btn-sm" onClick={() => setInv({ email: '', role: 'staff', password: '' })}><Plus size={14} /> Add staff</button>}>
              {!canManage ? <InlineAlert tone="neutral">Only owners and managers can manage staff.</InlineAlert> : (
                <>
                  <div className="divide-y divide-gray-100">
                    {staff.data?.items.map((u) => (
                      <div key={u.adminUserId} className="flex items-center justify-between py-2.5 text-sm">
                        <span className="font-medium">{u.email}{u.isYou && <span className="text-xs text-gray-400 font-normal"> (you)</span>}</span>
                        <span className="flex items-center gap-2">
                          <select className="input py-1 text-xs w-28" value={u.role} disabled={u.isYou} onChange={(e) => setRole.mutate({ id: u.adminUserId, role: e.target.value })}>
                            {['owner', 'manager', 'staff', 'read_only'].map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                          {!u.isYou && <button className="text-gray-300 hover:text-danger" aria-label="Remove staff" onClick={() => delStaff.mutate(u.adminUserId)}><Trash2 size={15} /></button>}
                        </span>
                      </div>
                    ))}
                  </div>
                  {inv && (
                    <div className="space-y-2 pt-1 max-w-lg">
                      <div className="flex gap-2"><input className="input" placeholder="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /><select className="input w-32" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{['staff', 'manager', 'owner', 'read_only'].map((r) => <option key={r}>{r}</option>)}</select></div>
                      <input className="input" type="password" placeholder="initial password (min 8)" value={inv.password} onChange={(e) => setInv({ ...inv, password: e.target.value })} />
                      <p className="text-xs text-gray-400">The invitee signs in with this email and password; they can change it later.</p>
                      {addStaff.error && <InlineAlert tone="critical">{(addStaff.error as Error).message}</InlineAlert>}
                      <div className="flex gap-2"><button className="btn-primary" disabled={addStaff.isPending || !inv.email || inv.password.length < 8} onClick={() => addStaff.mutate()}>{addStaff.isPending ? <Spinner className="text-white" /> : 'Add staff'}</button><button className="btn-ghost" onClick={() => setInv(null)}>Cancel</button></div>
                    </div>
                  )}
                </>
              )}
            </FormSection>
          )}

          {section === 'account' && (
            <FormSection title="Account" description="Your personal sign-in to SellRight.">
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between max-w-md"><dt className="text-gray-500">Email</dt><dd className="font-medium">{me?.email}</dd></div>
                <div className="flex justify-between max-w-md"><dt className="text-gray-500">Your role</dt><dd className="font-medium capitalize">{store?.role}</dd></div>
              </dl>
              <div className="border-t border-gray-100 pt-4">
                <p className="text-xs text-gray-500 mb-2">Signing out ends your session on this device.</p>
                <button className="btn-danger" onClick={() => void logout()}>Sign out</button>
              </div>
            </FormSection>
          )}
        </div>
      </div>
    </>
  );
}
