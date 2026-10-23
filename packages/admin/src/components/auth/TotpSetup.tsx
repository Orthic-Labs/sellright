import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { AuthAlert, AuthField, AuthSpinner, CodeInput } from './AuthShell';

interface Setup { secret: string; otpauthUri: string; qrSvg: string; issuer: string; account: string; passwordRequired: boolean }

/** Group a base32 secret in fours for reading aloud / typing. */
export const groupSecret = (s: string) => s.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? s;

/**
 * Authenticator-app enrolment (issue #333): the API mints a NEW pending secret for this session on every mount (it
 * rotates until confirmed) and renders the QR itself; the screen shows the QR, the key grouped in fours with Copy, an
 * "Open in authenticator app" link on mobile, and asks only for the 6-digit code — plus the current password when the
 * session is not freshly signed in.
 */
export function TotpSetup({ onEnabled, onCancel, cancelLabel = 'Back' }: { onEnabled: (recoveryCodes: string[]) => void; onCancel?: () => void; cancelLabel?: string }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  async function start() {
    setLoadErr(null); setSetup(null); setCode('');
    try {
      const s = await api.post<Setup>('/2fa/setup');
      setSetup(s); setNeedPassword(s.passwordRequired);
    } catch (e) { setLoadErr(e instanceof ApiError ? e.message : 'Could not start setup. Try again.'); }
  }
  useEffect(() => { void start(); }, []);

  async function enable(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || code.length !== 6 || (needPassword && !password)) return;
    setCodeErr(null); setPwErr(null); setFormErr(null); setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/2fa/enable', { code, ...(needPassword ? { password } : {}) });
      onEnabled(r.recoveryCodes);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === 'PASSWORD_REQUIRED') { setNeedPassword(true); setPwErr('Enter your current password to confirm.'); }
      else if (e2 instanceof ApiError && e2.code === 'SETUP_EXPIRED') { setFormErr('That setup expired, so we made a new QR code. Scan it again.'); void start(); }
      else if (e2 instanceof ApiError && e2.status === 401) setPwErr('That password isn’t right.');
      else if (e2 instanceof ApiError && e2.status === 409) { setCodeErr('That code didn’t match. Wait for a new code in your app and try again.'); setCode(''); codeRef.current?.focus(); }
      else if (e2 instanceof ApiError && e2.status === 429) setFormErr(e2.message);
      else setFormErr('Something went wrong. Try again.');
    } finally { setBusy(false); }
  }

  if (loadErr) return <><AuthAlert tone="danger">{loadErr}</AuthAlert><button type="button" className="auth-btn auth-btn-secondary" onClick={start}>Try again</button></>;
  if (!setup) return <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><AuthSpinner label="Preparing your QR code" /></div>;

  return (
    <form onSubmit={enable} noValidate style={{ display: 'contents' }}>
      {formErr && <AuthAlert tone="danger">{formErr}</AuthAlert>}
      <p className="auth-hint"><strong>1.</strong> Scan this QR code with an authenticator app such as Google Authenticator or 1Password.</p>
      <div className="auth-qr"><img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} alt={`QR code to add ${setup.issuer} (${setup.account}) to an authenticator app`} width={200} height={200} /></div>
      <div className="auth-field">
        <span className="auth-label">Can’t scan it? Enter this key</span>
        <div className="auth-secret">
          <code aria-label="Setup key">{groupSecret(setup.secret)}</code>
          <button type="button" className="auth-small-btn" onClick={async () => { try { await navigator.clipboard.writeText(setup.secret); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* blocked */ } }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <a className="auth-link is-small auth-mobile-only" href={setup.otpauthUri}>Open in authenticator app</a>
      </div>
      <p className="auth-hint"><strong>2.</strong> Enter the 6-digit code your app shows.</p>
      <CodeInput inputRef={codeRef} label="6-digit code" value={code} error={codeErr} disabled={busy} onChange={setCode} />
      {needPassword && (
        <AuthField label="Current password" toggle autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={pwErr}
          hint="You signed in a while ago, so confirm it’s you." />
      )}
      <button type="submit" className="auth-btn auth-btn-primary" disabled={busy || code.length !== 6 || (needPassword && !password)}>
        {busy ? <AuthSpinner label="Turning on two-step verification" /> : 'Enable'}
      </button>
      {onCancel && <div className="auth-links"><button type="button" className="auth-link is-small" onClick={onCancel}>{cancelLabel}</button></div>}
    </form>
  );
}
