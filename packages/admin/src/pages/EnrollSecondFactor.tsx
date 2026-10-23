import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { AuthAlert, AuthField, AuthShell, AuthSpinner } from '../components/auth/AuthShell';
import { RecoveryCodes } from '../components/auth/RecoveryCodes';
import { TotpSetup } from '../components/auth/TotpSetup';
import { useBranding } from '../lib/branding';
import { browserSupportsWebAuthn, capabilities, defaultPasskeyLabel, isStepUpRequired, passkeyErrorMessage, registerPasskey } from '../lib/passkeys';

type View = 'choose' | 'totp' | 'confirm' | 'codes';

/**
 * Mandatory two-step enrolment right after sign-in (issue #333): a passkey first (recommended — a strong factor on
 * its own), an authenticator app as the alternative, then the one-time recovery codes. The API lets this session do
 * nothing else until a factor is enrolled.
 */
export default function EnrollSecondFactor() {
  const { me, refresh, logout } = useAuth();
  const { branding } = useBranding();
  const [view, setView] = useState<View>('choose');
  const [pkAvailable, setPkAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [pwErr, setPwErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const ok = browserSupportsWebAuthn() && (await capabilities()).passkeys;
      if (live) setPkAvailable(ok);
    })();
    return () => { live = false; };
  }, []);

  async function addPasskey() {
    setErr(null); setBusy(true);
    try {
      const r = await registerPasskey(defaultPasskeyLabel());
      if (r.recoveryCodes?.length) { setCodes(r.recoveryCodes); setView('codes'); }
      else await refresh();
    } catch (e) {
      if (isStepUpRequired(e)) setView('confirm');
      else setErr(passkeyErrorMessage(e));
    } finally { setBusy(false); }
  }

  async function confirmPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setPwErr(null); setBusy(true);
    try {
      await api.post('/step-up', { password });
      setPassword(''); setView('choose');
      setBusy(false);
      await addPasskey();
      return;
    } catch (e2) {
      setPwErr(e2 instanceof ApiError && e2.status === 429 ? e2.message : 'That password isn’t right.');
    }
    setBusy(false);
  }

  const signOut = <button type="button" className="auth-link is-small" onClick={() => { void logout(); }}>Sign out</button>;
  const who = me?.email ? <>Two-step verification is required for <strong>{me.email}</strong>.</> : 'Two-step verification is required for your account.';

  if (view === 'codes') {
    return (
      <AuthShell wide title="Save your recovery codes" subtitle="Your account is protected.">
        <RecoveryCodes codes={codes} storeName={branding.storeName} account={me?.email} onDone={() => { void refresh(); }} doneLabel="Continue to admin" />
      </AuthShell>
    );
  }
  if (view === 'totp') {
    return (
      <AuthShell wide title="Set up an authenticator app" subtitle={who} footer={signOut}>
        <TotpSetup onEnabled={(c) => { setCodes(c); setView('codes'); }} onCancel={() => setView('choose')} cancelLabel="Use a passkey instead" />
      </AuthShell>
    );
  }
  if (view === 'confirm') {
    return (
      <AuthShell title="Confirm it’s you" subtitle="You signed in a while ago. Enter your password to add a passkey." footer={signOut}>
        <form onSubmit={confirmPassword} noValidate style={{ display: 'contents' }}>
          <AuthField label="Password" toggle autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} error={pwErr} />
          <button type="submit" className="auth-btn auth-btn-primary" disabled={busy || !password}>{busy ? <AuthSpinner label="Checking" /> : 'Continue'}</button>
        </form>
        <div className="auth-links"><button type="button" className="auth-link is-small" onClick={() => setView('choose')}>Back</button></div>
      </AuthShell>
    );
  }
  return (
    <AuthShell wide title="Secure your account" subtitle={who} footer={signOut}>
      {err && <AuthAlert tone="danger">{err}</AuthAlert>}
      {pkAvailable !== false && (
        <section className="auth-option is-recommended" aria-labelledby="opt-passkey">
          <div className="auth-option-head"><h2 id="opt-passkey" className="auth-option-title">Set up a passkey</h2><span className="auth-badge">Recommended</span></div>
          <p className="auth-hint">Sign in with your fingerprint, face or screen lock. Nothing to type, and it can’t be phished.</p>
          <button type="button" className="auth-btn auth-btn-primary" disabled={busy || pkAvailable === null} onClick={addPasskey}>
            {busy ? <AuthSpinner label="Waiting for your device" /> : 'Set up a passkey'}
          </button>
        </section>
      )}
      <section className="auth-option" aria-labelledby="opt-totp">
        <h2 id="opt-totp" className="auth-option-title">{pkAvailable === false ? 'Use an authenticator app' : 'Use an authenticator app instead'}</h2>
        <p className="auth-hint">Scan a QR code with an app such as Google Authenticator or 1Password, then enter its 6-digit codes when you sign in.</p>
        <button type="button" className={`auth-btn ${pkAvailable === false ? 'auth-btn-primary' : 'auth-btn-secondary'}`} disabled={busy} onClick={() => { setErr(null); setView('totp'); }}>Set up an authenticator app</button>
      </section>
    </AuthShell>
  );
}
