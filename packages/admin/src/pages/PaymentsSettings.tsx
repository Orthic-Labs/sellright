import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { ErrorState, Field, FormSection, InlineAlert, Loading, PageHeader, Spinner } from '../components/ui';

type FieldStatus = { envManaged: boolean; configured: boolean; last4: string | null };
type StatusResponse = Record<string, Record<string, FieldStatus>>;

const PROVIDERS: Array<{ id: 'stripe' | 'nmi' | 'sezzle'; label: string; modes: [string, string]; fields: Array<{ key: string; label: string }> }> = [
  { id: 'stripe', label: 'Stripe', modes: ['test', 'live'], fields: [
    { key: 'publishableKey', label: 'Publishable key' },
    { key: 'secretKey', label: 'Secret (or restricted) key' },
    { key: 'webhookSecret', label: 'Webhook signing secret (manual fallback)' },
  ] },
  { id: 'nmi', label: 'NMI', modes: ['test', 'live'], fields: [
    { key: 'securityKey', label: 'Security key' },
    { key: 'tokenizationKey', label: 'Tokenization key' },
    { key: 'privateKey', label: 'Chargeback webhook signing secret (optional)' },
  ] },
  { id: 'sezzle', label: 'Sezzle', modes: ['sandbox', 'production'], fields: [
    { key: 'publicKey', label: 'Public key' },
    { key: 'privateKey', label: 'Private key' },
  ] },
];

export default function PaymentsSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['payments-settings'];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<StatusResponse>('/payments/settings') });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: ({ provider, mode, field, value }: { provider: string; mode: string; field: string; value: string }) =>
      api.put(`/payments/settings/${provider}/${mode}`, { fields: { [field]: value } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); toast.success('Saved'); },
    onError: (e) => toast.error('Save failed', (e as Error).message),
  });

  const verify = useMutation({
    mutationFn: ({ provider, mode }: { provider: string; mode: string }) =>
      api.post<{ ok: boolean; error?: string }>(`/payments/settings/${provider}/${mode}/verify`, {}),
    onSuccess: (r) => (r.ok ? toast.success('Connection OK') : toast.error('Connection failed', r.error ?? '')),
    onError: (e) => toast.error('Test failed', (e as Error).message),
  });

  const createWebhook = useMutation({
    mutationFn: (mode: 'test' | 'live') => api.post<{ endpointId: string; created: boolean; recreated: boolean }>(`/payments/settings/stripe/${mode}/webhook`, {}),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: key }); toast.success(r.created ? 'Webhook created' : r.recreated ? 'Webhook recreated' : 'Webhook already up to date'); },
    onError: (e) => toast.error('Webhook setup failed', (e as Error).message),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState title="Couldn't load payment settings" message={(error as Error).message} onRetry={() => qc.invalidateQueries({ queryKey: key })} />;
  if (!data) return null;

  const draftKey = (p: string, m: string, f: string) => `${p}:${m}:${f}`;

  return (
    <>
      <PageHeader title="Payments" subtitle="Test and live credentials are separate — switching mode never copies one into the other. A field set by server configuration (environment variable) is read-only here." />
      {PROVIDERS.map((p) => (
        <FormSection key={p.id} title={p.label}>
          {p.modes.map((mode) => (
            <div key={mode} className="mb-4 border-t first:border-t-0 pt-4 first:pt-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium capitalize">{mode}</h3>
                <div className="flex gap-2">
                  {p.id === 'stripe' && (mode === 'test' || mode === 'live') && (
                    <button type="button" className="btn-secondary text-xs" onClick={() => createWebhook.mutate(mode as 'test' | 'live')} disabled={createWebhook.isPending}>
                      {createWebhook.isPending ? <Spinner /> : 'Create/refresh webhook'}
                    </button>
                  )}
                  <button type="button" className="btn-secondary text-xs" onClick={() => verify.mutate({ provider: p.id, mode })} disabled={verify.isPending}>
                    {verify.isPending ? <Spinner /> : 'Test connection'}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {p.fields.map((f) => {
                  const status = data[p.id]?.[`${mode}:${f.key}`];
                  const dk = draftKey(p.id, mode, f.key);
                  return (
                    <Field key={f.key} label={f.label} hint={status?.envManaged ? 'Managed by server configuration' : status?.configured ? `Configured (…${status.last4})` : 'Not configured'}>
                      <div className="flex gap-2">
                        <input
                          className="input" type="password" placeholder={status?.envManaged ? 'Set via environment' : status?.configured ? '••••••••' : 'Not set'}
                          disabled={status?.envManaged} value={drafts[dk] ?? ''}
                          onChange={(e) => setDrafts({ ...drafts, [dk]: e.target.value })}
                        />
                        <button
                          type="button" className="btn-secondary text-xs shrink-0"
                          disabled={status?.envManaged || !drafts[dk] || save.isPending}
                          onClick={() => { save.mutate({ provider: p.id, mode, field: f.key, value: drafts[dk]! }); setDrafts({ ...drafts, [dk]: '' }); }}
                        >
                          Save
                        </button>
                      </div>
                    </Field>
                  );
                })}
              </div>
            </div>
          ))}
        </FormSection>
      ))}
      <InlineAlert tone="info">Every "Test connection" call is read-only — it never charges, refunds, or moves money.</InlineAlert>
    </>
  );
}
