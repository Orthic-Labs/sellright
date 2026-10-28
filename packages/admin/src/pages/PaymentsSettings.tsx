/**
 * #406 Payments settings, rebuilt to the signed-off design: one card per provider with its real status
 * (store config), confirmations that spell out what customers see at checkout, keys tested before they are saved.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { LoadError, LoadingRows } from '../redesign/states';
import { ConfirmDlg } from '../redesign/payments/Dlg';
import { KeyDialog } from '../redesign/payments/KeyDialog';
import { ProviderCard, type DomainRow, type TestState } from '../redesign/payments/ProviderCard';
import {
  PROVIDERS, modeInUse, providerEnabled, wireMode,
  type CredStatus, type FieldDef, type KeyMode, type Provider, type ProviderDef, type StoreSettings, type VerifyResult,
} from '../redesign/payments/model';

type Confirm = { kind: 'toggle'; def: ProviderDef; on: boolean } | { kind: 'mode'; def: ProviderDef; to: KeyMode };

export default function PaymentsSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { store } = useAuth();
  const canManage = store?.role === 'owner' || store?.role === 'manager';
  const credKey = ['payments-settings', store?.slug];
  const setKey = ['payments-store-settings', store?.slug];
  const creds = useQuery({ queryKey: credKey, queryFn: () => api.get<CredStatus>('/payments/settings') });
  const settings = useQuery({ queryKey: setKey, queryFn: () => api.get<StoreSettings>('/settings/store') });
  const refresh = () => { void qc.invalidateQueries({ queryKey: credKey }); void qc.invalidateQueries({ queryKey: setKey }); };

  // Which key set each card displays. Display only: the mode in use never changes from here.
  const [shown, setShown] = useState<Partial<Record<Provider, KeyMode>>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [keyDlg, setKeyDlg] = useState<{ def: ProviderDef; field: FieldDef } | null>(null);
  const [tests, setTests] = useState<Partial<Record<Provider, TestState>>>({});
  const [testing, setTesting] = useState<Provider | null>(null);
  const [domains, setDomains] = useState<DomainRow[] | undefined>();

  const toggle = useMutation({
    mutationFn: ({ def, on }: { def: ProviderDef; on: boolean }) => api.patch('/settings/payments', { [def.id]: on }),
    onSuccess: (_r, v) => {
      refresh(); setConfirm(null);
      toast.success(v.on ? `${v.def.name} is active at checkout` : `${v.def.name} deactivated`, v.on ? 'Customers can pay with it now.' : "Customers can't pay with it at checkout.");
    },
    onError: (e) => { setConfirm(null); toast.error('Not changed', (e as Error).message); },
  });

  const switchMode = useMutation({
    mutationFn: ({ def, to }: { def: ProviderDef; to: KeyMode }) =>
      def.id === 'stripe' ? api.patch('/settings/payments/stripe-mode', { mode: to }) : api.patch('/settings/payments', { [def.id]: { mode: to } }),
    onSuccess: (_r, v) => { refresh(); setConfirm(null); setShown((s) => ({ ...s, [v.def.id]: v.to })); toast.success(`${v.def.name} now uses ${v.def.modeLabel[v.to].toLowerCase()} keys`); },
    onError: (e) => { setConfirm(null); toast.error('Not changed', (e as Error).message); },
  });

  const webhook = useMutation({
    mutationFn: (mode: KeyMode) => api.post<{ endpointId: string; created: boolean; recreated: boolean }>(`/payments/settings/stripe/${mode}/webhook`, {}),
    onSuccess: (r) => { refresh(); toast.success(r.created ? 'Webhook created' : r.recreated ? 'Webhook recreated' : 'Webhook already up to date'); },
    onError: (e) => toast.error('Webhook setup failed', (e as Error).message),
  });

  const registerDomains = useMutation({
    mutationFn: (mode: KeyMode) => api.post<{ mode: string; domains: DomainRow[] }>(`/payments/settings/stripe/${mode}/payment-method-domains`, {}),
    onSuccess: (r) => {
      setDomains(r.domains);
      const failed = r.domains.filter((d) => d.outcome === 'failed').length;
      if (failed) toast.error(`${failed} wallet domain${failed === 1 ? '' : 's'} failed`, 'Details are on the Stripe card.');
      else toast.success('Wallet domains registered');
    },
    onError: (e) => toast.error('Wallet domain registration failed', (e as Error).message),
  });

  const runTest = async (def: ProviderDef, mode: KeyMode) => {
    setTesting(def.id);
    try {
      const r = await api.post<VerifyResult>(`/payments/settings/${def.id}/${wireMode(def.id, mode)}/verify`, {});
      setTests((t) => ({ ...t, [def.id]: { ok: r.ok, message: r.ok ? 'Connection OK · tested just now' : `Connection failed${r.error ? `: ${r.error}` : ''}` } }));
      refresh();
    } catch (e) {
      setTests((t) => ({ ...t, [def.id]: { ok: false, message: `Test didn't run: ${(e as Error).message}` } }));
    } finally {
      setTesting(null);
    }
  };

  if (creds.isLoading || settings.isLoading) {
    return <div className="rd" style={{ flex: 1 }}><div className="ph"><h1>Payments</h1></div><LoadingRows label="Loading payment settings" rows={4} cols={[120, 0, 90]} /></div>;
  }
  if (creds.error || settings.error || !creds.data || !settings.data) {
    const e = (creds.error ?? settings.error) as Error | null;
    return (
      <div className="rd" style={{ flex: 1 }}>
        <div className="ph"><h1>Payments</h1></div>
        <div style={{ padding: '0 24px' }}><LoadError what="payment settings" detail={e?.message} onRetry={refresh} /></div>
      </div>
    );
  }
  const S = settings.data;
  const C = creds.data;
  const modeOf = (p: ProviderDef): KeyMode => shown[p.id] ?? modeInUse(p.id, S);

  return (
    <div className="rd" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="ph">
        <h1>Payments</h1>
        <span className="meta">Test and live keys are kept apart. Switching never copies one into the other.</span>
      </div>
      <div className="stack" style={{ padding: '4px 24px 32px', maxWidth: 880 }}>
        {!canManage && <div className="note" role="status"><span>Only owners and managers can change payment settings.</span></div>}
        {PROVIDERS.map((def) => (
          <ProviderCard key={def.id} def={def} creds={C} settings={S} canManage={canManage}
            showing={modeOf(def)} onShow={(m) => setShown((s) => ({ ...s, [def.id]: m }))}
            test={tests[def.id]} testing={testing === def.id} onTest={() => void runTest(def, modeOf(def))}
            onToggle={() => setConfirm({ kind: 'toggle', def, on: !providerEnabled(S.payments?.[def.id]) })}
            onSwitchMode={() => setConfirm({ kind: 'mode', def, to: modeInUse(def.id, S) === 'live' ? 'test' : 'live' })}
            onKey={(field) => setKeyDlg({ def, field })}
            onWebhook={() => webhook.mutate(modeOf(def))} webhookBusy={webhook.isPending}
            onDomains={() => registerDomains.mutate(modeOf(def))} domainsBusy={registerDomains.isPending} domains={def.id === 'stripe' ? domains : undefined} />
        ))}
      </div>

      {confirm?.kind === 'toggle' && (
        <ConfirmDlg open title={confirm.on ? `Activate ${confirm.def.name}?` : `Deactivate ${confirm.def.name}?`}
          confirmLabel={confirm.on ? `Activate ${confirm.def.name}` : `Deactivate ${confirm.def.name}`} danger={!confirm.on} busy={toggle.isPending}
          onClose={() => setConfirm(null)} onConfirm={() => toggle.mutate({ def: confirm.def, on: confirm.on })}>
          {confirm.on ? (
            <>
              <p>Customers will be able to pay with {confirm.def.name} at checkout right away.</p>
              <p className="muted">Checkout uses your {confirm.def.modeLabel[modeInUse(confirm.def.id, S)].toLowerCase()} keys{modeInUse(confirm.def.id, S) === 'live' ? ', so these are real payments' : ''}.</p>
            </>
          ) : (
            <>
              <p>Customers won't be able to pay with {confirm.def.name} at checkout from now on.</p>
              <p className="muted">Your saved keys stay in place. Orders already paid with {confirm.def.name} aren't changed.</p>
            </>
          )}
        </ConfirmDlg>
      )}
      {confirm?.kind === 'mode' && (
        <ConfirmDlg open title={`Switch ${confirm.def.name} to ${confirm.def.modeLabel[confirm.to].toLowerCase()} keys?`}
          confirmLabel={`Switch to ${confirm.def.modeLabel[confirm.to].toLowerCase()}`} busy={switchMode.isPending}
          onClose={() => setConfirm(null)} onConfirm={() => switchMode.mutate({ def: confirm.def, to: confirm.to })}>
          <p>Checkout will use your {confirm.def.modeLabel[confirm.to].toLowerCase()} {confirm.def.name} keys from now on.{confirm.to === 'live' ? ' Customers\' payments will be real.' : ''}</p>
          {!providerEnabled(S.payments?.[confirm.def.id]) && <p className="muted">{confirm.def.name} isn't active at checkout, so customers won't notice until you activate it.</p>}
        </ConfirmDlg>
      )}
      {keyDlg && (
        <KeyDialog def={keyDlg.def} mode={modeOf(keyDlg.def)} field={keyDlg.field}
          replacing={!!C[keyDlg.def.id]?.[`${wireMode(keyDlg.def.id, modeOf(keyDlg.def))}:${keyDlg.field.key}`]?.configured}
          invalidate={refresh} onClose={() => setKeyDlg(null)} />
      )}
    </div>
  );
}
