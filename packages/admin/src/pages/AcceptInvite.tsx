import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, auth, type LoginResp } from '../api';
import { useAuth } from '../auth';
import { Spinner } from '../components/ui';
import { adminHref } from '../lib/base-path';

/**
 * Staff invite acceptance. The invite email (and POST /v1/admin/staff/invites -> acceptUrl) links here as
 * /accept-invite?token=... under the admin base path. Public/pre-auth: lives outside <Protected>. The invitee sets a
 * password (POST /v1/admin/staff/accept, token-gated, CSRF-exempt) and is then signed in with it. The accept endpoint
 * deliberately does not echo the invited address, so the invitee types it to sign in.
 */
export default function AcceptInvite() {
  const { refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <ShellCard>
        <h1 className="text-base font-semibold">No invite token</h1>
        <p className="text-sm text-gray-500 mt-2">Open the link from your invitation email, or ask the store owner to send a new invite.</p>
        <Link className="btn-ghost mt-4" to="/login">Go to sign in</Link>
      </ShellCard>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setErr('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await api.post('/staff/accept', { token, password });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not accept the invite');
      setBusy(false);
      return;
    }
    try {
      const r = await api.post<LoginResp>('/login', { email, password });
      auth.store = r.stores?.[0]?.slug ?? null;
      await refresh();
      location.assign(adminHref('/'));
    } catch {
      // The invite is accepted; only the automatic sign-in failed (wrong email typed, or 2FA already on this account).
      location.assign(adminHref('/login'));
    }
  }

  return (
    <ShellCard>
      <h1 className="text-base font-semibold">Accept your invitation</h1>
      <p className="text-sm text-gray-500 mb-4">Choose a password to finish setting up your account. This link works once.</p>
      {err && <div role="alert" className="rounded-lg bg-danger-soft text-danger text-sm px-3 py-2 border border-danger/30 mb-4">{err}</div>}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <p className="text-xs text-gray-400 mt-1">The address this invitation was sent to.</p>
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <p className="text-xs text-gray-400 mt-1">At least 8 characters.</p>
        </div>
        <div>
          <label className="label">Confirm password</label>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? <Spinner className="text-white" /> : 'Accept invitation'}
        </button>
      </form>
    </ShellCard>
  );
}

function ShellCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full grid place-items-center bg-[#f1f1f1] p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="h-7 w-7 rounded bg-brand" />
          <span className="text-lg font-semibold tracking-tight">SellRight</span>
        </div>
        <div className="card p-6">{children}</div>
      </div>
    </div>
  );
}
