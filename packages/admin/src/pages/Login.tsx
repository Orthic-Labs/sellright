import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, auth, type LoginResp } from '../api';
import { useAuth } from '../auth';
import { Spinner } from '../components/ui';

export default function Login() {
  const { me, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await api.post<LoginResp>('/login', { email, password, totp: need2fa ? totp : undefined });
      if (r.twoFactorRequired) { setNeed2fa(true); setBusy(false); return; } // prompt for the 6-digit code
      // session is now in an httpOnly cookie; just pick the active store and load.
      auth.store = r.stores?.[0]?.slug ?? null;
      await refresh();
      location.assign('/');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Login failed');
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid place-items-center bg-[#f1f1f1] p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="h-7 w-7 rounded bg-brand" />
          <span className="text-lg font-semibold tracking-tight">SellRight</span>
        </div>
        <form onSubmit={submit} className="card p-6 space-y-4">
          <div>
            <h1 className="text-base font-semibold">Sign in</h1>
            <p className="text-sm text-gray-500">Manage your stores</p>
          </div>
          {err && <div className="rounded-lg bg-red-50 text-red-700 text-sm px-3 py-2 border border-red-200">{err}</div>}
          {!need2fa ? (
            <>
              <div>
                <label className="label">Email</label>
                <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div>
                <label className="label">Password</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
            </>
          ) : (
            <div>
              <label className="label">Authentication code</label>
              <input className="input tracking-widest text-center" inputMode="numeric" autoFocus maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} placeholder="000000" required />
              <p className="text-xs text-gray-400 mt-1">From your authenticator app.</p>
            </div>
          )}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? <Spinner className="text-white" /> : need2fa ? 'Verify' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
