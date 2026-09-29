import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { auth } from '../api';
import { useAuth } from '../auth';
import { Spinner } from '../components/ui';
import { appHref } from '../lib/base-path';

/**
 * One-click install claim screen (plan §1.4) — screen 1 of 3. Reached via the
 * link `sellright setup-link` prints: /setup?token=... . Public/pre-auth —
 * talks to /v1/setup/claim directly (NOT the /v1/admin/* api client, which
 * always requires a session). A successful claim sets the session cookie
 * itself (same response shape as /v1/admin/login), so this hands off straight
 * into the authenticated onboarding flow at /onboarding.
 */
export default function Setup() {
  const { me } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to="/" replace />;

  if (!token) {
    return (
      <ShellCard>
        <h1 className="text-base font-semibold">No setup token</h1>
        <p className="text-sm text-gray-500 mt-2">
          This page needs a claim link. On the server, run <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">sellright setup-link</code> and open the URL it prints.
        </p>
      </ShellCard>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 12) { setErr('Password must be at least 12 characters.'); return; }
    if (password !== confirm) { setErr('Passwords do not match.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/v1/setup/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, email, name, password }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (res.status === 429) { setErr('Too many attempts — wait a few minutes and try again.'); setBusy(false); return; }
      if (res.status === 404) { setErr('This claim link is invalid, expired, already used, or this installation is already claimed.'); setBusy(false); return; }
      if (!res.ok) { setErr(json?.error ?? `HTTP ${res.status}`); setBusy(false); return; }
      auth.store = json.storeSlug ?? null;
      // Full page load (not client-side navigate): App() decides claim-gated
      // routing from a one-shot GET /v1/setup/status on mount, so a real
      // reload is what makes it re-check and see "claimed" this time —
      // otherwise every route would keep rendering this screen.
      window.location.assign(appHref('/onboarding'));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Claim failed');
      setBusy(false);
    }
  }

  return (
    <ShellCard>
      <h1 className="text-base font-semibold">Claim your installation</h1>
      <p className="text-sm text-gray-500 mb-4">Create the owner account for this SellRight install. This link works once.</p>
      {err && <div className="rounded-lg bg-danger-soft text-danger text-sm px-3 py-2 border border-danger/30 mb-4">{err}</div>}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Your name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input" type="password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
          <p className="text-xs text-gray-400 mt-1">At least 12 characters. Never the same as any database password or key.</p>
        </div>
        <div>
          <label className="label">Confirm password</label>
          <input className="input" type="password" minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? <Spinner className="text-white" /> : 'Claim this installation'}
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
