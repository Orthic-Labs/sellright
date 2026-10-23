import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, auth, ApiError, type LoginResp } from '../api';
import { useAuth } from '../auth';
import { AuthAlert, AuthField, AuthShell, AuthSpinner, CodeInput } from '../components/auth/AuthShell';
import { adminHref } from '../lib/base-path';

/**
 * Staff invite acceptance. The invite e-mail links here as /accept-invite?token=... under the admin base path.
 * Public/pre-auth: lives outside <Protected>. A brand-new invitee chooses a password (POST /v1/admin/staff/accept,
 * token-gated, CSRF-exempt) and is then signed in with it. When the invited address already has an account the token is
 * NOT enough (the API answers INVITE_SIGN_IN_REQUIRED): the invitee signs in with their CURRENT password (+ 2FA code
 * if on, as the second sign-in step — issue #333) and then accepts from that session — one sign-in, so a 2FA code is
 * used exactly once. Their password is
 * never changed by an invite. The accept endpoint does not echo the invited address, so the invitee
 * types it to sign in.
 */
export default function AcceptInvite() {
  const { refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [existing, setExisting] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string; confirm?: string; code?: string }>({});
  const [busy, setBusy] = useState(false);
  const back = <Link className="auth-link is-small" to="/login">Go to sign in</Link>;

  if (!token) {
    return (
      <AuthShell title="This invitation link is incomplete" subtitle="Open the link from your invitation email again, or ask the store owner to send a new invite." footer={back}>
        <Link className="auth-btn auth-btn-secondary" to="/login">Go to sign in</Link>
      </AuthShell>
    );
  }

  async function signedIn(r: LoginResp) {
    await api.post('/staff/accept', { token });
    auth.store = r.stores?.[0]?.slug ?? null;
    await refresh();
    location.assign(adminHref('/'));
  }
  const acceptError = (e: unknown) => setErr(e instanceof ApiError && e.code === 'INVITE_SIGN_IN_REQUIRED'
    ? 'Sign in with the address this invitation was sent to.'
    : e instanceof ApiError && e.status === 429 ? e.message
    : e instanceof Error ? e.message : 'Could not accept the invite');

  async function submitCode(value: string) {
    if (!challenge || busy) return;
    setErr(null); setFieldErr({}); setBusy(true);
    try { await signedIn(await api.post<LoginResp>('/login/2fa', { challengeToken: challenge, code: value })); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'LOGIN_CHALLENGE_EXPIRED') { setChallenge(null); setPassword(''); setErr('That took too long. Enter your password again.'); }
      else if (e instanceof ApiError && e.code === 'INVALID_CODE') { setFieldErr({ code: 'That code didn’t work. Try again.' }); setCode(''); }
      else acceptError(e);
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setFieldErr({});
    if (challenge) { if (code.trim()) void submitCode(code.trim()); return; }
    if (!email.trim()) { setFieldErr({ email: 'Enter the address this invitation was sent to.' }); return; }
    if (!password) { setFieldErr({ password: existing ? 'Enter your current password.' : 'Choose a password.' }); return; }
    if (!existing) {
      if (password.length < 8) { setFieldErr({ password: 'Use at least 8 characters.' }); return; }
      if (password !== confirm) { setFieldErr({ confirm: 'The passwords don’t match.' }); return; }
    }
    setBusy(true);
    if (existing) {
      // Sign in once as the existing account (password, then its second step if it has one), then accept from that session.
      try {
        const r = await api.post<LoginResp>('/login', { email, password });
        if (r.twoFactorRequired && r.challengeToken) { setChallenge(r.challengeToken); setUseRecovery(!(r.methods ?? []).includes('totp')); setBusy(false); return; }
        await signedIn(r);
      } catch (e2: unknown) {
        if (e2 instanceof ApiError && e2.status === 401) setFieldErr({ password: 'Incorrect email or password.' });
        else acceptError(e2);
        setBusy(false);
      }
      return;
    }
    try {
      await api.post('/staff/accept', { token, password });
    } catch (e2: unknown) {
      if (e2 instanceof ApiError && e2.code === 'INVITE_SIGN_IN_REQUIRED' && !existing) {
        // The address already has an account: switch to "confirm your current password".
        setExisting(true);
        setPassword(''); setConfirm('');
        setErr(null);
      } else {
        acceptError(e2);
      }
      setBusy(false);
      return;
    }
    try {
      const r = await api.post<LoginResp>('/login', { email, password });
      if (r.twoFactorRequired) { location.assign(adminHref('/login')); return; }
      auth.store = r.stores?.[0]?.slug ?? null;
      await refresh();
      location.assign(adminHref('/'));
    } catch {
      // The invite is accepted; only the automatic sign-in failed (wrong email typed).
      location.assign(adminHref('/login'));
    }
  }

  if (challenge) {
    return (
      <AuthShell title="Two-step verification" subtitle={useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'} footer={back}>
        {err && <AuthAlert tone="danger">{err}</AuthAlert>}
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          {useRecovery
            ? <AuthField label="Recovery code" autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus value={code} onChange={(e) => setCode(e.target.value)} error={fieldErr.code} />
            : <CodeInput value={code} error={fieldErr.code} disabled={busy} onChange={(v) => { setCode(v); if (v.length === 6) void submitCode(v); }} />}
          <button type="submit" className="auth-btn auth-btn-primary" disabled={busy || (useRecovery ? code.trim().length < 16 : code.length !== 6)}>{busy ? <AuthSpinner label="Verifying" /> : 'Verify and accept'}</button>
        </form>
        <div className="auth-links"><button type="button" className="auth-link is-small" onClick={() => { setUseRecovery((v) => !v); setCode(''); }}>{useRecovery ? 'Use your authenticator app' : 'Use a recovery code'}</button></div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={existing ? 'Join with your existing account' : 'Accept your invitation'}
      subtitle={existing ? 'This address already has an account. Sign in to join this store — your password isn’t changed. This link works once.'
        : 'Choose a password to finish setting up your account. This link works once.'}
      footer={back}
    >
      {err && <AuthAlert tone="danger">{err}</AuthAlert>}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <AuthField label="Email" type="email" autoFocus autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false}
          value={email} onChange={(e) => setEmail(e.target.value)} required error={fieldErr.email} hint="The address this invitation was sent to." />
        {existing ? (
          <AuthField label="Current password" toggle autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required error={fieldErr.password} />
        ) : (
          <>
            <AuthField label="Password" toggle autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required error={fieldErr.password} hint="At least 8 characters." />
            <AuthField label="Confirm password" toggle autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required error={fieldErr.confirm} />
          </>
        )}
        <button type="submit" className="auth-btn auth-btn-primary" disabled={busy}>
          {busy ? <AuthSpinner label="Working" /> : existing ? 'Sign in and accept' : 'Accept invitation'}
        </button>
      </form>
    </AuthShell>
  );
}
