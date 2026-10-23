import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { FormSection, Field, InlineAlert, Spinner } from './ui';
import { ConfirmDialog } from './ConfirmDialog';
import { StepUpDialog } from './StepUpDialog';
import {
  browserSupportsWebAuthn, capabilities, deletePasskey, isStepUpRequired, listPasskeys, passkeyErrorMessage, registerPasskey, renamePasskey, type PasskeyRow,
} from '../lib/passkeys';
import { RecoveryCodes } from './auth/RecoveryCodes';
import { authThemeVars } from '../lib/branding';
import type { CSSProperties } from 'react';

function fmt(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** Settings > Security > Passkeys. Hidden entirely when the API reports passkeys are off. */
export function PasskeysSection() {
  const qc = useQueryClient();
  const caps = useQuery({ queryKey: ['admin-capabilities'], queryFn: capabilities, staleTime: 60_000 });
  const enabled = caps.data?.passkeys === true;
  const list = useQuery({ queryKey: ['admin-passkeys'], queryFn: listPasskeys, enabled });
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<null | { retry: () => void }>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  if (!enabled) return null;

  const trimmed = label.trim();
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-passkeys'] });

  async function run(action: () => Promise<void>, again: () => void) {
    setErr(null); setBusy(true);
    try { await action(); await refresh(); }
    catch (e) {
      if (isStepUpRequired(e)) setStepUp({ retry: again });
      else setErr(passkeyErrorMessage(e));
    } finally { setBusy(false); }
  }

  function add() {
    if (!trimmed || trimmed.length > 64) return;
    void run(async () => { const r = await registerPasskey(trimmed); setLabel(''); if (r.recoveryCodes?.length) setCodes(r.recoveryCodes); }, add);
  }

  function rename() {
    const next = editing?.label.trim();
    if (!editing || !next || next.length > 64) return;
    const { id } = editing;
    void run(async () => { await renamePasskey(id, next); setEditing(null); }, rename);
  }

  function remove(id: string) {
    void run(async () => { await deletePasskey(id); }, () => remove(id));
  }

  const items: PasskeyRow[] = list.data ?? [];

  return (
    <FormSection title="Passkeys" description="Sign in with your fingerprint, face or device PIN instead of a password.">
      {!browserSupportsWebAuthn() && <InlineAlert tone="neutral">This browser does not support passkeys.</InlineAlert>}
      {err && <InlineAlert tone="critical">{err}</InlineAlert>}
      {codes && (
        <div style={{ ...(authThemeVars(null) as CSSProperties), maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--a-text)' }}>
          <InlineAlert tone="positive" title="Two-step verification is on.">Your passkey is now your second factor.</InlineAlert>
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} doneLabel="Done" />
        </div>
      )}
      {list.isLoading ? <Spinner /> : items.length === 0 ? (
        <p className="text-sm text-gray-500">No passkeys yet.</p>
      ) : (
        <ul aria-label="Passkeys" className="divide-y divide-gray-100 border border-gray-200 rounded-lg max-w-xl">
          {items.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                {editing?.id === p.id ? (
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); rename(); }}>
                    <input aria-label="Passkey name" className="input" maxLength={64} autoFocus value={editing.label} onChange={(e) => setEditing({ id: p.id, label: e.target.value })} />
                    <button className="btn-primary btn-sm" disabled={busy || !editing.label.trim()}>Save</button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : <div className="font-medium truncate">{p.label}</div>}
                <div className="text-xs text-gray-500">
                  {p.deviceType === 'multiDevice' || p.backedUp ? 'Synced' : 'This device'} · Added {fmt(p.createdAt)} · Last used {fmt(p.lastUsedAt)}
                </div>
              </div>
              {editing?.id !== p.id && (
                <div className="flex gap-1">
                  <button className="btn-ghost btn-sm" aria-label={`Rename ${p.label}`} disabled={busy} onClick={() => setEditing({ id: p.id, label: p.label })}><Pencil size={14} /></button>
                  <button className="btn-ghost btn-sm" aria-label={`Remove ${p.label}`} disabled={busy} onClick={() => setConfirmId(p.id)}><Trash2 size={14} /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Field label="Passkey name" htmlFor="pk-label" hint="For example: Work laptop or Phone.">
        <input id="pk-label" className="input max-w-sm" maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div>
        <button className="btn-primary" disabled={!trimmed || busy || !browserSupportsWebAuthn()} onClick={add}>
          {busy ? <Spinner className="text-white" /> : 'Add a passkey'}
        </button>
      </div>
      <ConfirmDialog
        open={confirmId != null}
        title="Remove this passkey?"
        description="You will no longer be able to sign in with it."
        confirmLabel="Remove" tone="danger"
        onCancel={() => setConfirmId(null)}
        onConfirm={() => { const id = confirmId!; setConfirmId(null); remove(id); }}
      />
      {stepUp && (
        <StepUpDialog
          description="Confirm it's you before changing your passkeys."
          onCancel={() => setStepUp(null)}
          onVerified={() => { const r = stepUp.retry; setStepUp(null); r(); }}
        />
      )}
    </FormSection>
  );
}
