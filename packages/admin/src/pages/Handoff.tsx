import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { adminHref } from '../lib/base-path';
import { PENDING_KEY } from '../lib/handoff-pending';
import { AuthAlert, AuthShell, AuthSpinner } from '../components/auth/AuthShell';

const PARAMS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method'] as const;

function readParams(): Record<string, string> | null {
  const q = new URLSearchParams(location.search);
  if (PARAMS.every((k) => q.get(k))) {
    const p = Object.fromEntries(PARAMS.map((k) => [k, q.get(k)!]));
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* the page still works without a sign-in detour */ }
    return p;
  }
  try { const raw = sessionStorage.getItem(PENDING_KEY); return raw ? JSON.parse(raw) as Record<string, string> : null; } catch { return null; }
}

const clearPending = () => { try { sessionStorage.removeItem(PENDING_KEY); } catch { /* nothing to clear */ } };

function hostOf(uri: string | undefined): string {
  try { return uri ? new URL(uri).host : ''; } catch { return ''; }
}

/**
 * #355 phase 3, target side: another SellRight admin (the hub) asks to save this account. The admin confirms here,
 * signed in on THIS server with its own password, second factor and passkeys; the server issues a one-use code only to
 * a registered hub and only for a recent sign-in.
 */
export default function Handoff() {
  const { loading, me } = useAuth();
  const [params] = useState(readParams);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!loading && !me && params) location.assign(adminHref('/login'));
  }, [loading, me, params]);

  const hub = hostOf(params?.redirect_uri);

  async function approve() {
    if (!params || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ redirectTo: string }>('/handoff/authorize', {
        clientId: params.client_id, redirectUri: params.redirect_uri, state: params.state,
        codeChallenge: params.code_challenge, codeChallengeMethod: params.code_challenge_method,
      });
      clearPending();
      location.assign(r.redirectTo);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === 'STEP_UP_REQUIRED') setStale(true);
      else if (e instanceof ApiError && (e.code === 'HANDOFF_UNKNOWN_CLIENT' || e.code === 'HANDOFF_BAD_REQUEST')) setErr('This request didn’t come from an admin this server trusts. Nothing was shared.');
      else if (e instanceof ApiError && e.code === 'FEATURE_DISABLED') setErr('Saving accounts to another admin isn’t turned on for this server.');
      else if (e instanceof ApiError && e.code === 'HANDOFF_HUMAN_ONLY') setErr('Only a person signed in with their own password can do this.');
      else setErr('That didn’t work. Try again in a moment.');
    }
  }

  async function signInAgain() {
    // The handoff hands out a long-lived session, so it needs a sign-in from the last 10 minutes.
    try { await api.post('/logout'); } catch { /* the sign-in screen follows either way */ }
    location.assign(adminHref('/login'));
  }

  function cancel() { clearPending(); location.assign(adminHref('/')); }

  if (!params) {
    return (
      <AuthShell title="Nothing to approve" subtitle="This link is incomplete or was already used." footer={<a className="auth-link is-small" href={adminHref('/')}>Go to the admin</a>}>
        <AuthAlert tone="info">Start again from the admin where you want to save this account.</AuthAlert>
      </AuthShell>
    );
  }
  if (loading || !me) return <AuthShell title="Save this account" subtitle="Checking your sign-in…"><AuthSpinner label="Loading" /></AuthShell>;
  return (
    <AuthShell title="Save this account to another admin?"
      subtitle={<>The admin at <strong>{hub || 'another server'}</strong> will be able to work in this server as <strong>{me.email}</strong> until you remove it there or sign out of it.</>}
      footer={<button type="button" className="auth-link is-small" onClick={cancel}>Cancel</button>}>
      {stale && <AuthAlert tone="info">For your security, sign in again to approve this. You’ll come straight back here.</AuthAlert>}
      {err && <AuthAlert tone="danger">{err}</AuthAlert>}
      {stale
        ? <button type="button" className="auth-btn auth-btn-primary" onClick={() => void signInAgain()}>Sign in again</button>
        : <button type="button" className="auth-btn auth-btn-primary" disabled={busy || !!err} onClick={() => void approve()}>
            {busy ? <AuthSpinner label="Approving" /> : 'Save account'}
          </button>}
    </AuthShell>
  );
}
