import { useEffect, useState } from 'react';
import { api } from '../api';
import { Spinner } from './ui';
import { capabilities, listPasskeys, passkeyErrorMessage, stepUpWithPasskey, browserSupportsWebAuthn } from '../lib/passkeys';

/**
 * Re-auth prompt for step-up gated routes. Offers a passkey first when this admin has at least one;
 * the password + code form is always the fallback. The TOTP field is always shown (the API never reveals
 * whether 2FA is on).
 */
export function StepUpDialog({ description, onVerified, onCancel }: { description: string; onVerified: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!browserSupportsWebAuthn()) return;
      const caps = await capabilities();
      if (!caps.passkeys) return;
      try { const items = await listPasskeys(); if (live) setHasPasskey(items.length >= 1); } catch { /* fall back to password */ }
    })();
    return () => { live = false; };
  }, []);

  async function passkey() {
    setErr(null); setBusy(true);
    try { await stepUpWithPasskey(); onVerified(); }
    catch (e) { setErr(passkeyErrorMessage(e)); }
    finally { setBusy(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await api.post('/step-up', { password, totp: totp || undefined });
      onVerified();
    } catch (e2: unknown) {
      setErr(e2 instanceof Error ? e2.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 animate-fade-in" onClick={onCancel} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Confirm it's you" className="fixed inset-x-0 top-[15vh] z-50 mx-auto w-full max-w-sm px-3">
        <form onSubmit={submit} className="card p-6 stack-y-4 shadow-lg">
          <div>
            <h2 className="text-base font-semibold">Confirm it's you</h2>
            <p className="text-sm text-gray-500">{description}</p>
          </div>
          {err && <div role="alert" className="rounded-lg bg-danger-soft text-danger text-sm px-3 py-2 border border-danger/30">{err}</div>}
          {hasPasskey && (
            <>
              <button type="button" className="btn-primary w-full" disabled={busy} onClick={passkey}>
                {busy ? <Spinner className="text-white" /> : 'Use passkey'}
              </button>
              <p className="text-xs text-gray-400 text-center">or use your password</p>
            </>
          )}
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" autoFocus={!hasPasskey} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <label className="label">2FA code or recovery code</label>
            <input className="input tracking-widest" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} maxLength={19} value={totp} onChange={(e) => setTotp(e.target.value.replace(/[^0-9A-Za-z-]/g, ''))} placeholder="000000" />
            <p className="text-xs text-gray-400 mt-1">The 6-digit code from your authenticator app, or one of your recovery codes.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn-primary flex-1" disabled={busy || !password}>
              {busy ? <Spinner className="text-white" /> : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
