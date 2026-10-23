import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { AuthAlert, AuthField, AuthShell, AuthSpinner, formatWait, useCountdown } from '../components/auth/AuthShell';

/** Issue #333: "Forgot password?" — always the same confirmation, whether or not the address has an account. */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const wait = useCountdown(lockedUntil);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || wait > 0) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr('Enter the email address you sign in with.'); return; }
    setErr(null); setBusy(true);
    try { await api.post('/password/forgot', { email: email.trim() }); setSent(true); }
    catch (e2) {
      if (e2 instanceof ApiError && e2.status === 429) setLockedUntil(Date.now() + (Number((e2.body as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds) || 60) * 1000);
      else setErr('We couldn’t send the link right now. Try again in a moment.');
    } finally { setBusy(false); }
  }

  const back = <Link className="auth-link is-small" to="/login">Back to sign in</Link>;
  if (sent) {
    return (
      <AuthShell title="Check your email" subtitle={<>If <strong>{email.trim()}</strong> has an admin account, we’ve sent a link to choose a new password. It works once and expires in 30 minutes.</>} footer={back}>
        <AuthAlert tone="info">Didn’t get it? Check your spam folder, or try again in a few minutes.</AuthAlert>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Reset your password" subtitle="Enter your email and we’ll send you a link to choose a new password." footer={back}>
      {wait > 0 && <AuthAlert tone="danger">Too many requests. Try again in <strong>{formatWait(wait)}</strong>.</AuthAlert>}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <AuthField label="Email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} autoFocus
          value={email} onChange={(e) => setEmail(e.target.value)} error={err} />
        <button type="submit" className="auth-btn auth-btn-primary" disabled={busy || wait > 0}>
          {busy ? <AuthSpinner label="Sending" /> : 'Send reset link'}
        </button>
      </form>
    </AuthShell>
  );
}
