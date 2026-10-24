import { useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api, ApiError, auth, type LoginResp, type SecondFactorMethod } from '../api';
import { useAuth } from '../auth';
import { AuthAlert, AuthField, AuthShell, AuthSpinner, CodeInput, formatWait, useCountdown } from '../components/auth/AuthShell';
import { adminHref } from '../lib/base-path';
import { browserSupportsWebAuthn, capabilities, loginWithPasskey, passkeyErrorMessage } from '../lib/passkeys';

/**
 * Admin sign-in (issue #333), the standard two-step flow:
 *  1. email + password only ("Sign in with a passkey" as the secondary action; modal only, no autofill ceremony);
 *  2. ONLY when the password was right AND the account has a second factor, the API answers a short-lived single-use
 *     challenge and this screen asks for the 6-digit code (auto-submits at 6 digits), a recovery code, or the passkey.
 * No code field is ever shown to an account without 2FA. The server keeps the password-verified state; nothing here
 * gates on the client.
 */
type Step = { kind: 'credentials' } | { kind: 'code'; challengeToken: string; methods: SecondFactorMethod[]; mode: 'totp' | 'recovery' | 'passkey' };

const retryAfterOf = (e: unknown): number | null => {
  if (!(e instanceof ApiError) || e.status !== 429) return null;
  const n = Number((e.body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds);
  if (Number.isFinite(n) && n > 0) return n;
  const m = /in (\d+)s/.exec(e.message);
  return m ? Number(m[1]) : 60;
};


export default function Login() {
  const { me } = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ email: string | null; password: string | null }>({ email: null, password: null });
  const [busy, setBusy] = useState(false);
  const [pk, setPk] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const wait = useCountdown(lockedUntil);
  const locked = wait > 0;
  const codeRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);

  async function finish(r: LoginResp) {
    // Same post-login path for every method (a pending 2FA enrolment is handled by the app shell after load).
    auth.store = r.stores?.[0]?.slug ?? null;
    // The full load below boots the shell, whose AuthProvider reads /me once: no separate /me first (#362).
    location.assign(adminHref('/'));
  }

  // Passkeys are modal only, like GitHub: the button starts the one ceremony. No conditional (autofill) ceremony runs in
  // the background, because aborting it to start the button's ceremony breaks extension-based passkey providers.
  useEffect(() => {
    let live = true;
    (async () => {
      if (!browserSupportsWebAuthn()) return;
      const caps = await capabilities();
      if (!live || !caps.passkeys) return;
      setPk(true);
    })();
    return () => { live = false; };
    // eslint-disable-next-line
  }, []);

  // Focus the code field on the code step and again after every failed attempt (the field is re-enabled then).
  useEffect(() => { if (step.kind === 'code' && !busy) codeRef.current?.focus(); }, [step, busy, fieldErr]);

  if (me) return <Navigate to="/" replace />;

  function fail(e: unknown, fallback: string) {
    const retry = retryAfterOf(e);
    if (retry) { setLockedUntil(Date.now() + retry * 1000); setFormErr(null); setFieldErr(null); return; }
    if (e instanceof ApiError && (e.code === 'LOGIN_CHALLENGE_EXPIRED' || e.code === 'LOGIN_CHALLENGE_EXHAUSTED')) {
      setStep({ kind: 'credentials' }); setCode(''); setPassword('');
      setNotice(e.code === 'LOGIN_CHALLENGE_EXHAUSTED' ? 'Too many incorrect codes. Enter your password again.' : 'Your sign-in timed out. Enter your password again.');
      return;
    }
    if (e instanceof ApiError && (e.status === 401 || e.status === 400)) { setFieldErr(fallback); return; }
    setFormErr(e instanceof ApiError ? e.message : 'Something went wrong. Check your connection and try again.');
  }

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (busy || locked) return;
    setFieldErr(null); setFormErr(null); setNotice(null);
    const missing = { email: !email.trim() ? 'Enter your email address.' : null, password: !password ? 'Enter your password.' : null };
    setMissing(missing);
    if (missing.email || missing.password) return;
    setBusy(true);
    try {
      const r = await api.post<LoginResp>('/login', { email: email.trim(), password });
      if (r.twoFactorRequired && r.challengeToken) {
        const methods = r.methods ?? ['totp', 'recovery_code'];
        // Passkey mode only where this browser can actually use one; otherwise the recovery code.
        setStep({ kind: 'code', challengeToken: r.challengeToken, methods, mode: methods.includes('totp') ? 'totp' : methods.includes('passkey') && pk ? 'passkey' : 'recovery' });
        setCode(''); setBusy(false);
        return;
      }
      await finish(r);
    } catch (err) {
      fail(err, 'Incorrect email or password.');
      setBusy(false);
    }
  }

  async function submitCode(value: string) {
    if (step.kind !== 'code' || submitting.current || locked) return;
    submitting.current = true;
    setFieldErr(null); setFormErr(null); setBusy(true);
    try {
      await finish(await api.post<LoginResp>('/login/2fa', { challengeToken: step.challengeToken, code: value }));
    } catch (err) {
      fail(err, step.mode === 'recovery' ? 'That recovery code didn’t work. Check it and try again.' : 'That code didn’t work. Check your authenticator app and try again.');
      setCode('');
      setBusy(false);
    } finally { submitting.current = false; }
  }

  async function passkeyLogin() {
    setFieldErr(null); setFormErr(null); setNotice(null); setBusy(true);
    try { await finish(await loginWithPasskey()); }
    catch (e) {
      const retry = retryAfterOf(e);
      if (retry) setLockedUntil(Date.now() + retry * 1000);
      else setFormErr(passkeyErrorMessage(e));
      setBusy(false);
    }
  }

  const rateAlert = locked && (
    <AuthAlert tone="danger">Too many attempts. For your security, sign-in is paused. Try again in <strong>{formatWait(wait)}</strong>.</AuthAlert>
  );
  const storeLine = 'Sign in to manage your store.';

  if (step.kind === 'code') {
    const recovery = step.mode === 'recovery';
    const passkeyMode = step.mode === 'passkey';
    return (
      <AuthShell
        title={recovery ? 'Use a recovery code' : passkeyMode ? 'Confirm it’s you' : 'Two-step verification'}
        subtitle={recovery ? 'Enter one of the recovery codes you saved when you set up two-step verification. Each code works once.'
          : passkeyMode ? 'Use your passkey to finish signing in.'
          : 'Enter the 6-digit code from your authenticator app.'}
        footer={<button type="button" className="auth-link is-small" onClick={() => { setStep({ kind: 'credentials' }); setCode(''); setFieldErr(null); setFormErr(null); }}>Back to sign in</button>}
      >
        {rateAlert}
        {formErr && <AuthAlert tone="danger">{formErr}</AuthAlert>}
        {passkeyMode ? (
          <button type="button" className="auth-btn auth-btn-primary" disabled={busy || locked} onClick={passkeyLogin}>
            {busy ? <AuthSpinner label="Waiting for your passkey" /> : 'Use your passkey'}
          </button>
        ) : (
          <form noValidate onSubmit={(e) => { e.preventDefault(); if (code.trim()) void submitCode(code.trim()); }} style={{ display: 'contents' }}>
            {recovery ? (
              <AuthField inputRef={codeRef} label="Recovery code" name="recovery-code" autoComplete="off" autoCapitalize="none" spellCheck={false}
                placeholder="xxxx-xxxx-xxxx-xxxx" value={code} onChange={(e) => setCode(e.target.value)} error={fieldErr} autoFocus />
            ) : (
              <CodeInput inputRef={codeRef} value={code} error={fieldErr} disabled={busy || locked}
                onChange={(v) => { setCode(v); if (v.length === 6) void submitCode(v); }} />
            )}
            <button type="submit" className="auth-btn auth-btn-primary" disabled={busy || locked || (recovery ? code.trim().length < 16 : code.length !== 6)}>
              {busy ? <AuthSpinner label="Verifying" /> : 'Verify'}
            </button>
          </form>
        )}
        <div className="auth-links">
          {step.mode !== 'totp' && step.methods.includes('totp') && <button type="button" className="auth-link is-small" onClick={() => { setStep({ ...step, mode: 'totp' }); setCode(''); setFieldErr(null); }}>Use your authenticator app</button>}
          {step.mode !== 'passkey' && step.methods.includes('passkey') && pk && <button type="button" className="auth-link is-small" onClick={() => { setStep({ ...step, mode: 'passkey' }); setFieldErr(null); }}>Use a passkey</button>}
          {!recovery && <button type="button" className="auth-link is-small" onClick={() => { setStep({ ...step, mode: 'recovery' }); setCode(''); setFieldErr(null); }}>Use a recovery code</button>}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in" subtitle={storeLine}>
      {notice && <AuthAlert tone="info">{notice}</AuthAlert>}
      {rateAlert}
      {formErr && <AuthAlert tone="danger">{formErr}</AuthAlert>}
      <form onSubmit={submitCredentials} noValidate style={{ display: 'contents' }}>
        <AuthField label="Email" type="email" name="email" autoComplete="username" autoFocus inputMode="email" autoCapitalize="none" spellCheck={false}
          value={email} onChange={(e) => setEmail(e.target.value)} required error={missing.email} />
        <AuthField label="Password" name="password" toggle autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required error={missing.password ?? fieldErr}
          aside={<Link className="auth-link is-small" to="/forgot-password">Forgot password?</Link>} />
        <button type="submit" className="auth-btn auth-btn-primary" disabled={busy || locked}>
          {busy ? <AuthSpinner label="Signing in" /> : 'Sign in'}
        </button>
      </form>
      {pk && (
        <>
          <div className="auth-divider">or</div>
          <button type="button" className="auth-btn auth-btn-secondary" disabled={busy || locked} onClick={passkeyLogin}>Sign in with a passkey</button>
        </>
      )}
    </AuthShell>
  );
}
