import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Download, ExternalLink } from 'lucide-react';
import { api, type Checklist, type RecoveryKit } from '../api';
import { useAuth } from '../auth';
import { useToast } from './Toast';
import { Loading, Spinner } from './ui';

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
    onError: (e) => toast.error('Could not download recovery kit', (e as Error).message),
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
    </div>
  );
}
