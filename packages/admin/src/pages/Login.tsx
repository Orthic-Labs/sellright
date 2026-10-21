import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, auth, type LoginResp } from '../api';
import { useAuth } from '../auth';
import { Spinner } from '../components/ui';
import { adminHref } from '../lib/base-path';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, capabilities, loginWithPasskey, passkeyErrorMessage } from '../lib/passkeys';

export default function Login() {
  const { me, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pk, setPk] = useState(false);

  async function finish(r: LoginResp) {
    // Same post-login path as the password form (a pending TOTP enrolment is handled by the app shell after load).
    auth.store = r.stores?.[0]?.slug ?? null;
    await refresh();
    location.assign(adminHref('/'));
  }

  useEffect(() => {
    let live = true;
    (async () => {
      if (!browserSupportsWebAuthn()) return;
      const caps = await capabilities();
      if (!live || !caps.passkeys) return;
      setPk(true);
      try {
        if (!(await browserSupportsWebAuthnAutofill())) return;
        const r = await loginWithPasskey({ useBrowserAutofill: true });
        if (live) await finish(r);
      } catch { /* conditional UI is best-effort; the button and password form remain */ }
    })();
    return () => { live = false; };
    // eslint-disable-next-line
  }, []);

  async function passkeyLogin() {
    setErr(null); setBusy(true);
    try { await finish(await loginWithPasskey({ useBrowserAutofill: false })); }
    catch (e) {
      setErr(passkeyErrorMessage(e));
      setBusy(false);
    }
  }

  if (me) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      // The API answers a bad password, an unknown email AND a 2FA account that sent no code with the same generic 401
      // (it must never reveal which accounts have 2FA), so the screen cannot wait for a "2FA required" signal. Instead
      // the optional authentication-code field is always offered and sent together with the password.
      const r = await api.post<LoginResp>('/login', { email, password, totp: totp || undefined });
      // session is now in an httpOnly cookie; just pick the active store and load.
      auth.store = r.stores?.[0]?.slug ?? null;
      await refresh();
      location.assign(adminHref('/'));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Login failed');
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid place-items-center bg-[#f1f1f1] p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="h-7 w-7 rounded-sm bg-brand" />
          <span className="text-lg font-semibold tracking-tight">SellRight</span>
        </div>
        <form onSubmit={submit} className="card p-6 stack-y-4">
          <div>
            <h1 className="text-base font-semibold">Sign in</h1>
            <p className="text-sm text-gray-500">Manage your stores</p>
          </div>
          {err && <div className="rounded-lg bg-danger-soft text-danger text-sm px-3 py-2 border border-danger/30">{err}</div>}
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" autoComplete="username webauthn" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div>
            <label className="label">Authentication code</label>
            <input className="input tracking-widest text-center" autoComplete="one-time-code" maxLength={24} value={totp} onChange={(e) => setTotp(e.target.value.trim())} placeholder="000000" />
            <p className="text-xs text-gray-400 mt-1">Optional. If your account uses two-factor authentication, enter the 6-digit code from your authenticator app — or one of your recovery codes.</p>
          </div>
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? <Spinner className="text-white" /> : 'Sign in'}
          </button>
          {pk && (
            <button type="button" className="btn-secondary w-full" disabled={busy} onClick={passkeyLogin}>Use a passkey</button>
          )}
        </form>
      </div>
    </div>
  );
}
