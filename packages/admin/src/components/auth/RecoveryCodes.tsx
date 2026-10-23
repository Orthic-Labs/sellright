import { useState } from 'react';

/** One-time recovery codes (issue #333): shown once, with Copy and Download, and an explicit "I've saved them". */
export function RecoveryCodes({ codes, storeName, account, onDone, doneLabel = 'Continue' }: { codes: string[]; storeName?: string | null; account?: string; onDone: () => void; doneLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const text = [`Recovery codes${storeName ? ` — ${storeName} admin` : ''}${account ? ` (${account})` : ''}`, 'Each code signs you in once if you lose your passkey or authenticator.', '', ...codes, ''].join('\n');

  async function copy() {
    try { await navigator.clipboard.writeText(codes.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked: Download still works */ }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${(storeName ?? 'admin').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-recovery-codes.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <p className="auth-hint">Save these somewhere safe, such as your password manager. Each code works once if you lose access to your passkey or authenticator app. <strong>They won’t be shown again.</strong></p>
      <ul className="auth-codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="auth-row">
        <button type="button" className="auth-small-btn" onClick={copy}>{copied ? 'Copied' : 'Copy codes'}</button>
        <button type="button" className="auth-small-btn" onClick={download}>Download .txt</button>
      </div>
      <label className="auth-check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I’ve saved my recovery codes</label>
      <button type="button" className="auth-btn auth-btn-primary" disabled={!saved} onClick={onDone}>{doneLabel}</button>
    </>
  );
}
