import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { ErrorState, Field, FormSection, InlineAlert, Loading, PageHeader, Spinner } from '../components/ui';

/** GET /v1/admin/sheerid/config — secrets are never echoed, only whether they are set. */
type Status = {
  storeId: string; configured: boolean; programId: string | null; theme: string | null;
  hasWebhookSecret: boolean; hasClientCredentials: boolean; verificationTtlDays: number;
};

/** The PATCH body: text/number fields always travel (empty → null clears); the
 *  three secrets travel only when something was typed, so leaving one blank keeps
 *  the stored value. Exported for the page test. */
export function buildSheerIdPatch(form: { programId: string; theme: string; ttlDays: string; clientId: string; clientSecret: string; webhookSecret: string }) {
  const ttl = Number(form.ttlDays);
  return {
    programId: form.programId.trim() || null,
    theme: form.theme.trim() || null,
    ...(Number.isInteger(ttl) && ttl >= 1 && ttl <= 3650 ? { verificationTtlDays: ttl } : {}),
    ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
    ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
    ...(form.webhookSecret ? { webhookSecret: form.webhookSecret } : {}),
  };
}

export default function SheerIdSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['sheerid-config'];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<Status>('/sheerid/config') });
  const [form, setForm] = useState({ programId: '', theme: '', ttlDays: '365', clientId: '', clientSecret: '', webhookSecret: '' });

  useEffect(() => {
    if (data) setForm((f) => ({ ...f, programId: data.programId ?? '', theme: data.theme ?? '', ttlDays: String(data.verificationTtlDays) }));
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.patch<{ ok: boolean }>('/sheerid/config', buildSheerIdPatch(form)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      setForm((f) => ({ ...f, clientId: '', clientSecret: '', webhookSecret: '' }));
      toast.success('SheerID settings saved');
    },
    onError: (e) => toast.error('Save failed', (e as Error).message),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState title="Couldn't load SheerID settings" message={(error as Error).message} onRetry={() => qc.invalidateQueries({ queryKey: key })} />;
  if (!data) return null;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const webhookPath = `/v1/webhooks/sheerid/${data.storeId}`;

  return (
    <>
      <PageHeader title="SheerID" subtitle="Student, military, teacher and other verified discounts." />
      {!data.hasWebhookSecret || !data.hasClientCredentials ? (
        <InlineAlert tone="attention" title="Verification can't complete yet">
          {!data.hasClientCredentials ? 'API client ID and secret are not set. ' : ''}{!data.hasWebhookSecret ? 'The webhook secret is not set, so SheerID results are rejected.' : ''}
        </InlineAlert>
      ) : null}
      <FormSection title="Program" description="Default program id and hosted-page options.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Program id"><input className="input" value={form.programId} onChange={set('programId')} /></Field>
          <Field label="Theme id" hint="Optional hosted-flow theme."><input className="input" value={form.theme} onChange={set('theme')} /></Field>
          <Field label="Verification valid for (days)"><input className="input" inputMode="numeric" value={form.ttlDays} onChange={set('ttlDays')} /></Field>
        </div>
      </FormSection>
      <FormSection title="Credentials" description="Write-only. Saved values are never shown again; leave a field blank to keep what is stored.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Client ID" hint={data.hasClientCredentials ? 'Credentials are saved.' : undefined}>
            <input className="input" autoComplete="off" placeholder={data.hasClientCredentials ? '••••••••' : ''} value={form.clientId} onChange={set('clientId')} />
          </Field>
          <Field label="Client secret">
            <input className="input" type="password" autoComplete="new-password" placeholder={data.hasClientCredentials ? '••••••••' : ''} value={form.clientSecret} onChange={set('clientSecret')} />
          </Field>
          <Field label="Webhook secret" hint={data.hasWebhookSecret ? 'A webhook secret is saved.' : undefined}>
            <input className="input" type="password" autoComplete="new-password" placeholder={data.hasWebhookSecret ? '••••••••' : ''} value={form.webhookSecret} onChange={set('webhookSecret')} />
          </Field>
        </div>
        <p className="text-xs text-gray-500">In SheerID, point the webhook at <code>{webhookPath}</code> on this store's API host, using the same secret.</p>
        <div>
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
        </div>
      </FormSection>
    </>
  );
}
