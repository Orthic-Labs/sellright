import { useState } from 'react';
import { api } from '../api';
import { Spinner } from './ui';

/**
 * TOTP enrolment (P1b): start setup -> add the secret to an authenticator app -> confirm a code together with
 * the CURRENT password (the API re-proves it, so a hijacked session cannot enrol an attacker's device) -> show the
 * one-time recovery codes. Used by Settings > Security and by the enrolment-required screen.
 */
export function TwoFactorEnroll({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setErr(null); setBusy(true);
    try { setSetup(await api.post<{ secret: string; otpauthUri: string }>('/2fa/setup')); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await api.post<{ enabled: boolean; recoveryCodes: string[] }>('/2fa/enable', { secret: setup!.secret, code, password });
      setCodes(r.recoveryCodes);
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  }

  if (codes) {
    return (
      <div className="stack-y-3">
        <div role="status" className="rounded-lg border border-success/30 bg-success-soft p-3 text-sm text-emerald-800">2FA is on. Save these recovery codes somewhere safe — each one signs you in once if you lose your authenticator. They are shown only now.</div>
        <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-1 font-mono text-sm bg-gray-50 border border-gray-200 rounded-sm p-3 max-w-md">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <button className="btn-primary" onClick={onDone}>I have saved my recovery codes</button>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="stack-y-3">
        {err && <div role="alert" className="rounded-lg bg-danger-soft text-danger text-sm px-3 py-2 border border-danger/30">{err}</div>}
        <button className="btn-primary" disabled={busy} onClick={start}>{busy ? <Spinner className="text-white" /> : 'Set up an authenticator app'}</button>
      </div>
    );
  }

  return (
    <form className="stack-y-3" onSubmit={enable}>
      <p className="text-sm text-gray-600">Add this secret to your authenticator app, then enter the 6-digit code and your current password.</p>
      <div className="font-mono text-xs bg-gray-50 border border-gray-200 rounded-sm p-2 break-all max-w-lg">{setup.secret}</div>
      <a className="text-xs text-brand hover:underline break-all" href={setup.otpauthUri}>otpauth link</a>
      <div>
        <label className="label" htmlFor="tfa-code">Verification code</label>
        <input id="tfa-code" className="input tracking-widest text-center max-w-[10rem] tnum" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </div>
      <div>
        <label className="label" htmlFor="tfa-password">Your current password</label>
        <input id="tfa-password" className="input max-w-sm" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {err && <div role="alert" className="rounded-lg bg-danger-soft text-danger text-sm px-3 py-2 border border-danger/30">{err}</div>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={code.length !== 6 || !password || busy}>{busy ? <Spinner className="text-white" /> : 'Enable'}</button>
        {onCancel && <button type="button" className="btn-ghost" onClick={() => { setSetup(null); setCode(''); setPassword(''); onCancel(); }}>Cancel</button>}
      </div>
    </form>
  );
}
