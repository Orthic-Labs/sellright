import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { AuthAlert, AuthField, AuthShell, AuthSpinner } from '../components/auth/AuthShell';

const MIN = 10;

/** Issue #333: choose a new admin password from the e-mailed single-use link. 2FA stays on; every session ends. */
export default function ResetPassword() {
  const [params] = useSearchParams();
  // Keep the single-use token in memory only: drop it from the address bar (history, Referer, screenshots) on load.
  const [token] = useState(() => params.get('token') ?? '');
  useEffect(() => { if (params.has('token')) history.replaceState(history.state, '', location.pathname); }, [params]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errs, setErrs] = useState<{ password?: string; confirm?: string }>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const back = <Link className="auth-link is-small" to="/login">Back to sign in</Link>;
  // A dead link never shows the form: ask the API first (null = still checking).
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    if (!token) return;
    let on = true;
    api.post<{ valid: boolean }>('/password/reset/check', { token })
      .then((r) => { if (on) setLive(r.valid === true); })
      .catch(() => { if (on) setLive(true); }); // a transient failure: let the reset itself answer
    return () => { on = false; };
  }, [token]);

  if (!token || live === false) {
    return (
      <AuthShell title={token ? 'This link has expired' : 'This link is incomplete'}
        subtitle={token ? 'Reset links work once and expire after 30 minutes. Ask for a new one.' : 'Open the reset link from your email again, or ask for a new one.'} footer={back}>
        <Link className="auth-btn auth-btn-primary" to="/forgot-password">Send a new link</Link>
      </AuthShell>
    );
  }
  if (live === null) {
    return <AuthShell title="Checking your link" subtitle="One moment."><div style={{ display: 'flex', justifyContent: 'center' }}><AuthSpinner label="Checking your link" /></div></AuthShell>;
  }
  if (done) {
    return (
      <AuthShell title="Password updated" subtitle="Every session was signed out. Sign in with your new password; two-step verification still applies, and if you use passkeys you’ll confirm which to keep.">
        <Link className="auth-btn auth-btn-primary" to="/login">Sign in</Link>
      </AuthShell>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errs = {};
    if (password.length < MIN) next.password = `Use at least ${MIN} characters.`;
    if (!next.password && confirm !== password) next.confirm = 'The passwords don’t match.';
    setErrs(next); setFormErr(null);
    if (next.password || next.confirm) return;
    setBusy(true);
    try { await api.post('/password/reset', { token, password }); setDone(true); }
    catch (e2) {
      if (e2 instanceof ApiError && e2.code === 'RESET_INVALID') setLive(false);
      else if (e2 instanceof ApiError && e2.status === 429) setFormErr('Too many attempts. Wait a few minutes and try again.');
      else setFormErr('We couldn’t update your password. Try again.');
    } finally { setBusy(false); }
  }

  return (
    <AuthShell title="Choose a new password" subtitle={`At least ${MIN} characters. Resetting signs out every session.`} footer={back}>
      {formErr && <AuthAlert tone="danger">{formErr}</AuthAlert>}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
        <AuthField label="New password" toggle autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} error={errs.password} />
        <AuthField label="Confirm new password" toggle autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errs.confirm} />
        <button type="submit" className="auth-btn auth-btn-primary" disabled={busy}>
          {busy ? <AuthSpinner label="Saving" /> : 'Update password'}
        </button>
      </form>
    </AuthShell>
  );
}
