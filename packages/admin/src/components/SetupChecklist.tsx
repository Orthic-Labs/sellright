import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Download, ExternalLink } from 'lucide-react';
import { api, ApiError, type Checklist, type RecoveryKit } from '../api';
import { useAuth } from '../auth';
import { useToast } from './Toast';
import { Loading, Spinner } from './ui';

const STEP_UP_REQUIRED_MESSAGE = 'step_up_required';

/**
 * Re-auth prompt for GET /v1/admin/system/recovery-kit (plan follow-up: the
 * master key is sensitive enough that a merely-still-logged-in session isn't
 * enough — the admin must re-prove their password, right now, every 5
 * minutes). Always shows the TOTP field: the admin API never reveals whether
 * 2FA is enabled to an unauthenticated-for-this-purpose caller (same
 * enumeration-safety rule as login), so the client can't decide to hide it.
 */
function StepUpModal({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await api.post('/step-up', { password, totp: totp || undefined });
      onVerified();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 animate-fade-in" onClick={onCancel} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Confirm your password" className="fixed inset-x-0 top-[15vh] z-50 mx-auto w-full max-w-sm px-3">
        <form onSubmit={submit} className="card p-6 space-y-4 shadow-lg">
          <div>
            <h2 className="text-base font-semibold">Confirm it's you</h2>
            <p className="text-sm text-gray-500">The recovery kit contains your master key. Re-enter your password to continue.</p>
          </div>
          {err && <div className="rounded-lg bg-danger-soft text-danger text-sm px-3 py-2 border border-danger/30">{err}</div>}
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div>
            <label className="label">2FA code (if enabled)</label>
            <input className="input tracking-widest" inputMode="numeric" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} placeholder="000000" />
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

// Each checklist key's settings page + human label. Order matches the plan's
// checklist list (§1.5).
const ITEMS: Array<{ key: keyof Checklist; label: string; to: string }> = [
  { key: 'products', label: 'Products', to: '/products' },
  { key: 'domain', label: 'Domain', to: '/settings' },
  { key: 'payments', label: 'Payments', to: '/settings/payments' },
  { key: 'email', label: 'Email', to: '/settings/email' },
  { key: 'shippingAndTax', label: 'Shipping & tax', to: '/tax-zones' },
  { key: 'recoveryKit', label: 'Recovery kit downloaded', to: '#recovery-kit' },
  { key: 'offSiteBackup', label: 'Off-site backup', to: '#offsite-backup' },
];

/**
 * Setup checklist + Publish action (plan §1.5), shown on the dashboard for
 * any store not yet published. Each item's `ok` is computed server-side from
 * real data (GET /v1/admin/system/checklist) — this component never
 * second-guesses it.
 */
export default function SetupChecklist() {
  const { me, store, refresh } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['system-checklist', store?.slug];
  const [showStepUp, setShowStepUp] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<Checklist>('/system/checklist') });

  const confirmOffsite = useMutation({
    mutationFn: (confirmed: boolean) => api.patch('/system/checklist/offsite-backup-confirmed', { confirmed }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const downloadKit = useMutation({
    mutationFn: () => api.get<RecoveryKit>('/system/recovery-kit'),
    onSuccess: (kit) => {
      const blob = new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'recovery-kit.json'; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      qc.invalidateQueries({ queryKey: key });
      toast.success('Recovery kit downloaded — store it offline, away from this server.');
    },
    onError: (e) => {
      // 403 + this exact message means "installation admin, but no recent
      // step-up" — prompt for it instead of showing a generic failure toast.
      if (e instanceof ApiError && e.status === 403 && e.message === STEP_UP_REQUIRED_MESSAGE) {
        setShowStepUp(true);
        return;
      }
      toast.error('Could not download recovery kit', (e as Error).message);
    },
  });

  const publish = useMutation({
    mutationFn: () => api.patch<{ published: boolean }>('/settings/publish', { published: true }),
    onSuccess: async () => { await refresh(); toast.success('Store published'); },
    onError: (e: unknown) => {
      // The 409 body's `failing` list isn't worth plumbing through a second
      // error shape — the checklist below already shows exactly which items
      // are red, which is the same information.
      toast.error('Publish blocked', 'See the checklist below for what still needs attention.');
      qc.invalidateQueries({ queryKey: key });
      void e;
    },
  });

  if (isLoading || !data) return <div className="panel p-6 mb-6"><Loading /></div>;

  const doneCount = Object.values(data).filter((i) => i.ok).length;
  const total = Object.values(data).length;

  return (
    <div className="panel p-6 mb-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Setup checklist</h2>
          <p className="mt-0.5 text-sm text-gray-500">{doneCount} of {total} done. Your storefront preview is private until you publish.</p>
        </div>
        <button className="btn-primary" disabled={publish.isPending} onClick={() => publish.mutate()}>
          {publish.isPending ? <Spinner className="text-white" /> : 'Publish store'}
        </button>
      </div>
      <ul className="mt-4 divide-y divide-gray-100">
        {ITEMS.map(({ key: k, label, to }) => {
          const item = data[k];
          return (
            <li key={k} className="flex items-center justify-between py-2.5 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                {item.ok ? <CheckCircle2 size={16} className="text-success shrink-0" /> : <Circle size={16} className="text-gray-300 shrink-0" />}
                <span className="font-medium">{label}</span>
                <span className="text-gray-400 truncate">— {item.detail}</span>
              </div>
              {k === 'recoveryKit' ? (
                me?.isInstallationAdmin ? (
                  <button type="button" className="btn-secondary text-xs shrink-0" disabled={downloadKit.isPending} onClick={() => downloadKit.mutate()}>
                    {downloadKit.isPending ? <Spinner /> : <><Download size={12} className="inline mr-1" />Download</>}
                  </button>
                ) : (
                  <span className="text-xs text-gray-400 shrink-0">Installation admin only</span>
                )
              ) : k === 'offSiteBackup' ? (
                <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                  <input type="checkbox" checked={!!item.ok} onChange={(e) => confirmOffsite.mutate(e.target.checked)} />
                  Confirm configured
                </label>
              ) : (
                <Link to={to} className="text-xs text-brand hover:underline shrink-0 flex items-center gap-1">
                  {item.ok ? 'Review' : 'Set up'} <ExternalLink size={11} />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {showStepUp && (
        <StepUpModal
          onCancel={() => setShowStepUp(false)}
          onVerified={() => { setShowStepUp(false); downloadKit.mutate(); }}
        />
      )}
    </div>
  );
}
