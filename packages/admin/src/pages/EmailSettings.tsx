import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { ErrorState, Field, FormSection, InlineAlert, Loading, PageHeader, Spinner } from '../components/ui';

type SmtpConfig = { preset: string; host: string; port: number; secure: boolean; user?: string; from?: string };
type Status = { envManaged: boolean; config: Partial<SmtpConfig> | null; credentialConfigured: boolean };

const PRESETS = [
  { id: 'custom', label: 'Custom' },
  { id: 'gmail', label: 'Gmail / Google Workspace' },
  { id: 'ses', label: 'Amazon SES' },
  { id: 'postmark', label: 'Postmark' },
  { id: 'resend', label: 'Resend' },
];

export default function EmailSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['email-settings'];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<Status>('/email/settings') });
  const [form, setForm] = useState<SmtpConfig & { password: string }>({ preset: 'custom', host: '', port: 587, secure: false, user: '', from: '', password: '' });
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    if (data?.config) setForm((f) => ({ ...f, ...data.config }));
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put('/email/settings', { preset: form.preset, host: form.host, port: form.port, secure: form.secure, user: form.user, from: form.from || undefined, credential: form.password || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setForm((f) => ({ ...f, password: '' })); toast.success('Email settings saved'); },
    onError: (e) => toast.error('Save failed', (e as Error).message),
  });

  const testSend = useMutation({
    mutationFn: () => api.post<{ delivered: boolean; error?: string }>('/email/settings/test-send', { to: testTo }),
    onSuccess: (r) => (r.delivered ? toast.success('Test email sent') : toast.error('Send failed', r.error ?? '')),
    onError: (e) => toast.error('Send failed', (e as Error).message),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState title="Couldn't load email settings" message={(error as Error).message} onRetry={() => qc.invalidateQueries({ queryKey: key })} />;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Email" subtitle="Transactional email (order confirmations, password resets, notifications)." />
      {data.envManaged ? (
        <FormSection title="SMTP" description="Managed by server configuration (SMTP_HOST is set in the environment). Settings here can't be edited.">
          <InlineAlert tone="info">Send a test email to confirm the server's configured mailer is working.</InlineAlert>
        </FormSection>
      ) : (
        <FormSection title="SMTP">
          <Field label="Preset">
            <select className="input" value={form.preset} onChange={(e) => setForm({ ...form, preset: e.target.value })}>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Host"><input className="input" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></Field>
            <Field label="Port"><input className="input" inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 0 })} /></Field>
            <Field label="Username"><input className="input" value={form.user ?? ''} onChange={(e) => setForm({ ...form, user: e.target.value })} /></Field>
            <Field label="Password" hint={data.credentialConfigured ? 'A password is already saved — leave blank to keep it.' : undefined}>
              <input className="input" type="password" placeholder={data.credentialConfigured ? '••••••••' : ''} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <Field label="From address"><input className="input" type="email" value={form.from ?? ''} onChange={(e) => setForm({ ...form, from: e.target.value })} /></Field>
            <Field label="Use TLS (secure)">
              <label className="flex items-center gap-2 text-sm h-9"><input type="checkbox" checked={form.secure} onChange={(e) => setForm({ ...form, secure: e.target.checked })} /> Implicit TLS</label>
            </Field>
          </div>
          <div className="mt-3">
            <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
          </div>
        </FormSection>
      )}
      <FormSection title="Test send">
        <div className="flex gap-2">
          <input className="input" type="email" placeholder="you@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button type="button" className="btn-secondary shrink-0" onClick={() => testSend.mutate()} disabled={!testTo || testSend.isPending}>
            {testSend.isPending ? <Spinner /> : 'Send test email'}
          </button>
        </div>
      </FormSection>
    </>
  );
}
