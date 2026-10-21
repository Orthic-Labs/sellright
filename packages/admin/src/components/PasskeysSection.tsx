import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { ApiError } from '../api';
import { FormSection, Field, InlineAlert, Spinner } from './ui';
import { ConfirmDialog } from './ConfirmDialog';
import { StepUpDialog } from './StepUpDialog';
import {
  browserSupportsWebAuthn, capabilities, deletePasskey, isStepUpRequired, listPasskeys, passkeyErrorMessage, registerPasskey, type PasskeyRow,
} from '../lib/passkeys';

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

  if (!enabled) return null;

  const trimmed = label.trim();
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-passkeys'] });

  async function run(action: () => Promise<void>, again: () => void) {
    setErr(null); setBusy(true);
    try { await action(); await refresh(); }
    catch (e) {
      if (isStepUpRequired(e)) setStepUp({ retry: again });
      else if (e instanceof ApiError && e.code === 'TOTP_REQUIRED_FIRST') setErr('Set up your authenticator app first');
      else setErr(passkeyErrorMessage(e));
    } finally { setBusy(false); }
  }

  function add() {
    if (!trimmed || trimmed.length > 64) return;
    void run(async () => { await registerPasskey(trimmed); setLabel(''); }, add);
  }

  function remove(id: string) {
    void run(async () => { await deletePasskey(id); }, () => remove(id));
  }

  const items: PasskeyRow[] = list.data ?? [];

  return (
    <FormSection title="Passkeys" description="Sign in with your fingerprint, face or device PIN instead of a password.">
      {!browserSupportsWebAuthn() && <InlineAlert tone="neutral">This browser does not support passkeys.</InlineAlert>}
      {err && <InlineAlert tone="critical">{err}</InlineAlert>}
      {list.isLoading ? <Spinner /> : items.length === 0 ? (
        <p className="text-sm text-gray-500">No passkeys yet.</p>
      ) : (
        <ul aria-label="Passkeys" className="divide-y divide-gray-100 border border-gray-200 rounded-lg max-w-xl">
          {items.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium truncate">{p.label}</div>
                <div className="text-xs text-gray-500">
                  {p.deviceType === 'multiDevice' || p.backedUp ? 'Synced' : 'This device'} · Added {fmt(p.createdAt)} · Last used {fmt(p.lastUsedAt)}
                </div>
              </div>
              <button className="btn-ghost btn-sm" aria-label={`Remove ${p.label}`} disabled={busy} onClick={() => setConfirmId(p.id)}><Trash2 size={14} /></button>
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
