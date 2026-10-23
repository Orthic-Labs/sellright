import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { AuthAlert, AuthField, AuthShell, AuthSpinner } from '../components/auth/AuthShell';
import { listPasskeys, type PasskeyRow } from '../lib/passkeys';

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'Never');

/**
 * After a password reset (issue #333 review): the account's passkeys survive the reset, so the owner confirms — with the
 * NEW password — which ones to keep. Any passkey an intruder may have added goes here. Until then the API lets the
 * session do nothing else.
 */
export default function ReviewPasskeys() {
  const { me, refresh, logout } = useAuth();
  const [items, setItems] = useState<PasskeyRow[] | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState('');
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    listPasskeys().then((rows) => { if (on) { setItems(rows); setKeep(new Set(rows.map((r) => r.id))); } }).catch(() => { if (on) setErr('Could not load your passkeys. Reload the page.'); });
    return () => { on = false; };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) { setPwErr('Enter your new password to confirm.'); return; }
    setPwErr(null); setErr(null); setBusy(true);
    try {
      await api.post('/passkeys/review', { password, keep: [...keep] });
      await refresh();
    } catch (e2) {
      if (e2 instanceof ApiError && e2.status === 401) setPwErr('That password isn’t right.');
      else setErr(e2 instanceof ApiError ? e2.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  const removing = items ? items.length - keep.size : 0;
  return (
    <AuthShell wide title="Review your passkeys" subtitle={<>Your password was reset. Keep only the passkeys you recognise for <strong>{me?.email}</strong>.</>}
      footer={<button type="button" className="auth-link is-small" onClick={() => { void logout(); }}>Sign out</button>}>
      {err && <AuthAlert tone="danger">{err}</AuthAlert>}
      {!items ? <div style={{ display: 'flex', justifyContent: 'center' }}><AuthSpinner label="Loading your passkeys" /></div> : (
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <fieldset className="auth-option" style={{ margin: 0 }}>
            <legend className="auth-label" style={{ padding: '0 4px' }}>Passkeys on this account</legend>
            {items.map((p) => (
              <label key={p.id} className="auth-check">
                <input type="checkbox" checked={keep.has(p.id)} onChange={(e) => { const next = new Set(keep); if (e.target.checked) next.add(p.id); else next.delete(p.id); setKeep(next); }} />
                <span><strong>{p.label}</strong><br /><span className="auth-hint">Added {day(p.createdAt)} · Last used {day(p.lastUsedAt)}</span></span>
              </label>
            ))}
          </fieldset>
          {removing > 0 && <AuthAlert tone="info">{removing === 1 ? '1 passkey will be removed.' : `${removing} passkeys will be removed.`}</AuthAlert>}
          <input type="text" name="username" autoComplete="username" hidden readOnly value={me?.email ?? ''} />
          <AuthField label="New password" toggle autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={pwErr} />
          <button type="submit" className="auth-btn auth-btn-primary" disabled={busy}>{busy ? <AuthSpinner label="Saving" /> : 'Confirm and continue'}</button>
        </form>
      )}
    </AuthShell>
  );
}
