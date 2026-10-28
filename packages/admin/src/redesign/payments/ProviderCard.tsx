import { AlertTriangle } from 'lucide-react';
import { dateTime } from '../../lib/format';
import {
  NMI_WEBHOOK, STRIPE_WEBHOOK, fieldStatus, hasKeys, lastVerified, maskedKey, modeInUse, providerEnabled, wireMode,
  type CredStatus, type FieldDef, type KeyMode, type ProviderDef, type StoreSettings,
} from './model';

export interface TestState { ok: boolean; message: string }
export interface DomainRow { domain: string; outcome: string; applePay: string; googlePay: string; error?: string }

interface Props {
  def: ProviderDef;
  creds: CredStatus;
  settings: StoreSettings;
  canManage: boolean;
  showing: KeyMode;
  onShow: (m: KeyMode) => void;
  test?: TestState;
  testing: boolean;
  onTest: () => void;
  onToggle: () => void;
  onSwitchMode: () => void;
  onKey: (f: FieldDef) => void;
  /** Stripe only. */
  onWebhook?: () => void;
  webhookBusy?: boolean;
  onDomains?: () => void;
  domainsBusy?: boolean;
  domains?: DomainRow[];
}

function KeyRow({ def, creds, mode, field, canManage, onKey }: { def: ProviderDef; creds: CredStatus; mode: KeyMode; field: FieldDef; canManage: boolean; onKey: (f: FieldDef) => void }) {
  const st = fieldStatus(creds, def.id, mode, field.key);
  return (
    <div className="setrow">
      <span className="k">{field.label}</span>
      {st?.envManaged
        ? <span className="muted">Set by server configuration. Read-only here.</span>
        : st?.configured
          ? <span className="mono muted" aria-label={`${field.label} is set, ends in ${st.last4 ?? 'hidden'}`}>{maskedKey(st.last4)}</span>
          : <span className="dot">Not set</span>}
      {st?.envManaged
        ? <span />
        : <button className="btn sm" onClick={() => onKey(field)} disabled={!canManage}>{st?.configured ? 'Replace' : 'Add key'}</button>}
    </div>
  );
}

export function ProviderCard(p: Props) {
  const { def, creds, settings, canManage, showing } = p;
  const on = providerEnabled(settings.payments?.[def.id]);
  const inUse = modeInUse(def.id, settings);
  const ready = hasKeys(creds, def, inUse);
  const verified = lastVerified(def.id, showing, settings);
  const nmiHook = def.id === 'nmi' ? fieldStatus(creds, 'nmi', inUse, NMI_WEBHOOK.key) : undefined;
  const nmiHookMissing = def.id === 'nmi' && !nmiHook?.configured;
  const stripeHook = def.id === 'stripe' ? fieldStatus(creds, 'stripe', showing, STRIPE_WEBHOOK.key) : undefined;
  const stripeSecret = def.id === 'stripe' ? fieldStatus(creds, 'stripe', showing, 'secretKey') : undefined;
  const mLabel = (m: KeyMode) => def.modeLabel[m];
  const toMode: KeyMode = inUse === 'live' ? 'test' : 'live';

  return (
    <section className="card" aria-labelledby={`pay-${def.id}`}>
      <div className="ch">
        <span className="logo" style={{ background: 'rgb(var(--surface-2))', color: 'rgb(var(--text))' }} aria-hidden="true">{def.logo}</span>
        <div><h2 id={`pay-${def.id}`}>{def.name}</h2><div className="hint">{def.blurb}</div></div>
        <span className="sp" />
        <span className={`pill ${on ? 'ok' : 'neu'}`}>{on ? 'Active at checkout' : 'Not active'}</span>
        <button className={`btn sm${on ? ' dng' : ''}`} onClick={p.onToggle} disabled={!canManage || (!on && !ready)}
          title={!on && !ready ? `Add your ${mLabel(inUse).toLowerCase()} keys first` : undefined}>
          {on ? 'Deactivate…' : 'Activate…'}
        </button>
      </div>

      {nmiHookMissing && (
        <div className="strip warn" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span><b>Chargeback webhook isn't set up.</b> Disputes won't appear on orders.</span>
          <span className="sp" />
          <button className="btn sm" onClick={() => p.onKey(NMI_WEBHOOK)} disabled={!canManage}>Set up</button>
        </div>
      )}
      {!on && (
        <div className="strip neu" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>Checkout doesn't offer {def.name}. {ready ? `Your ${mLabel(inUse).toLowerCase()} keys are in place, so you can activate it.` : `Add your ${mLabel(inUse).toLowerCase()} keys, then activate.`}</span>
        </div>
      )}

      <div className="setrow">
        <span className="k">Checkout uses</span>
        <span className="dot g">{mLabel(inUse)} keys</span>
        <button className="btn sm" onClick={p.onSwitchMode} disabled={!canManage}>Switch to {mLabel(toMode).toLowerCase()}…</button>
      </div>

      <div className="setsub">
        <span className="fl-l" id={`show-${def.id}`}>Showing</span>
        <div className="seg" role="radiogroup" aria-labelledby={`show-${def.id}`}>
          {(['test', 'live'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={showing === m} tabIndex={showing === m ? 0 : -1} onClick={() => p.onShow(m)}>{mLabel(m)} keys</button>
          ))}
        </div>
        <span className="hint">This only changes which keys you see. Checkout uses {mLabel(inUse).toLowerCase()} keys.</span>
      </div>

      {def.keys.map((f) => <KeyRow key={f.key} def={def} creds={creds} mode={showing} field={f} canManage={canManage} onKey={p.onKey} />)}

      {def.id === 'nmi' && (
        <div className="setrow">
          <span className="k">{NMI_WEBHOOK.label}</span>
          {nmiHook?.envManaged ? <span className="dot g">Set by server configuration</span>
            : nmiHook?.configured ? <span className="dot g">Connected · <span className="mono muted">{maskedKey(nmiHook.last4)}</span></span>
            : <span className="dot">Not set</span>}
          {nmiHook?.envManaged ? <span /> : <button className="btn sm" onClick={() => p.onKey(NMI_WEBHOOK)} disabled={!canManage}>{nmiHook?.configured ? 'Replace' : 'Add key'}</button>}
        </div>
      )}

      {def.id === 'stripe' && (
        <>
          <div className="setrow">
            <span className="k">Webhook</span>
            {stripeHook?.configured ? <span className="dot g">Signing secret saved · <span className="mono muted">{maskedKey(stripeHook.last4)}</span></span> : <span className="dot">Created automatically from the secret key</span>}
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm" onClick={p.onWebhook} disabled={!canManage || !stripeSecret?.configured || p.webhookBusy}>{p.webhookBusy ? 'Working…' : 'Create or refresh'}</button>
              {!stripeHook?.envManaged && <button className="btn sm ghost" onClick={() => p.onKey(STRIPE_WEBHOOK)} disabled={!canManage}>Enter manually</button>}
            </span>
          </div>
          <div className="setrow">
            <span className="k">Apple Pay & Google Pay</span>
            <span className={p.domains ? '' : 'dot'}>
              {p.domains
                ? p.domains.map((d) => (
                  <span key={d.domain} style={{ display: 'block' }}>
                    {d.domain}: {d.outcome === 'failed' ? `failed (${d.error ?? 'error'})` : `Apple Pay ${d.applePay}, Google Pay ${d.googlePay}`}
                  </span>
                ))
                : 'Register this store\'s domains with Stripe'}
            </span>
            <button className="btn sm" onClick={p.onDomains} disabled={!canManage || !stripeSecret?.configured || p.domainsBusy}>{p.domainsBusy ? 'Working…' : 'Register domains'}</button>
          </div>
        </>
      )}

      <div className="setrow">
        <span className="k">Connection</span>
        {p.test
          ? <span className={`dot ${p.test.ok ? 'g' : 'a'}`} role="status">{p.test.message}</span>
          : verified ? <span className="dot g">Last test passed {dateTime(verified)}</span> : <span className="dot">Not tested</span>}
        <button className="btn sm" onClick={p.onTest} disabled={!canManage || p.testing}>{p.testing ? 'Testing…' : 'Test connection'}</button>
      </div>
      <div className="cfoot muted">Testing is read-only: it never charges, refunds or moves money. It checks the saved {mLabel(showing).toLowerCase()} keys ({wireMode(def.id, showing)}).</div>
    </section>
  );
}
