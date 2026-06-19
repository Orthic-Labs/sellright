import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, RefreshCw, Send, Users, ListChecks } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, PageHeader, Spinner, Badge, FormSection, Field, InlineAlert, EmptyState } from '../components/ui';

interface ListmonkList { id: number; name: string; subscribers: number; type: string; }

const isUrl = (v: string) => /^https?:\/\/.+/.test(v.trim());

export default function Marketing() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const cfgKey = ['lm-config', store?.slug];
  const { data: cfg, isLoading } = useQuery({ queryKey: cfgKey, queryFn: () => api.get<{ configured: boolean; url: string | null }>('/marketing/config') });

  const [form, setForm] = useState({ url: '', apiUser: '', apiToken: '' });
  const [touched, setTouched] = useState(false);
  const connect = useMutation({
    mutationFn: () => api.patch<{ ok: boolean; lists: number }>('/marketing/config', form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: cfgKey }); qc.invalidateQueries({ queryKey: ['lm-lists', store?.slug] }); },
  });

  const lists = useQuery({
    queryKey: ['lm-lists', store?.slug],
    queryFn: () => api.get<{ lists: ListmonkList[] }>('/marketing/lists'),
    enabled: !!cfg?.configured,
  });
  const sync = useMutation({ mutationFn: (listId: number) => api.post<{ synced: number; failed: number }>('/marketing/sync', { listId }), onSuccess: () => lists.refetch() });

  const [campaign, setCampaign] = useState<{ name: string; subject: string; listId: number; body: string } | null>(null);
  const createCampaign = useMutation({ mutationFn: () => api.post('/marketing/campaigns', campaign), onSuccess: () => setCampaign(null) });

  if (isLoading) return <Loading />;

  // Connection status drives the header badge.
  const status = cfg?.configured ? (lists.error ? 'failed' : 'connected') : (connect.isPending ? 'connecting' : 'not_connected');
  const urlError = touched && form.url && !isUrl(form.url) ? 'Enter a full URL including https://' : null;

  return (
    <>
      <PageHeader title="Marketing & Email" subtitle="Listmonk — managed right here, no separate login." actions={<Badge value={status} />} />

      {!cfg?.configured ? (
        <div className="max-w-xl space-y-4">
          <InlineAlert tone="info" title="Connect your Listmonk instance">
            Once connected, SellRight syncs your customers into Listmonk lists and lets you draft campaigns here. Sending stays in Listmonk for safety.
          </InlineAlert>
          <FormSection title="Connect Listmonk"
            actions={<button className="btn-primary" form="lm-connect" disabled={connect.isPending || !isUrl(form.url) || !form.apiUser || !form.apiToken}>{connect.isPending ? <><Spinner className="text-white" /> Connecting…</> : <><Mail size={15} /> Connect & verify</>}</button>}>
            <form id="lm-connect" className="space-y-4" onSubmit={(e) => { e.preventDefault(); setTouched(true); if (isUrl(form.url)) connect.mutate(); }}>
              <Field label="Listmonk URL" htmlFor="lm-url" error={urlError} hint="The base URL of your Listmonk install.">
                <input id="lm-url" className={`input ${urlError ? 'input-invalid' : ''}`} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} onBlur={() => setTouched(true)} placeholder="https://listmonk.example.com" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="API user" htmlFor="lm-user"><input id="lm-user" className="input" value={form.apiUser} onChange={(e) => setForm({ ...form, apiUser: e.target.value })} /></Field>
                <Field label="API token" htmlFor="lm-token"><input id="lm-token" className="input" type="password" value={form.apiToken} onChange={(e) => setForm({ ...form, apiToken: e.target.value })} /></Field>
              </div>
              {connect.error && <InlineAlert tone="critical" title="Connection failed">{(connect.error as Error).message}</InlineAlert>}
            </form>
          </FormSection>
        </div>
      ) : (
        <div className="space-y-5">
          <FormSection title="Connection" description="SellRight is syncing customers to this Listmonk instance."
            actions={<button className="btn-ghost btn-sm" onClick={() => { connect.reset(); qc.setQueryData(cfgKey, { configured: false, url: null }); }}>Reconfigure</button>}>
            <div className="flex items-center gap-2 text-sm">
              <Badge value={status} />
              <span className="font-mono text-xs text-gray-600">{cfg.url}</span>
            </div>
            {lists.error && <InlineAlert tone="critical" title="Can't reach Listmonk">{(lists.error as Error).message}</InlineAlert>}
          </FormSection>

          <div className="panel overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 text-sm font-semibold"><ListChecks size={16} className="text-gray-400" /> Lists</div>
            {lists.isLoading ? <Loading /> : lists.error ? null : lists.data && lists.data.lists.length === 0 ? (
              <EmptyState title="No lists in Listmonk yet" hint="Create a list in Listmonk, then sync customers into it." />
            ) : (
              <table className="w-full table-fixed">
                <thead><tr><th className="th">List</th><th className="th text-right" style={{ width: '18%' }}>Subscribers</th><th className="th text-right" style={{ width: '34%' }}></th></tr></thead>
                <tbody>
                  {lists.data?.lists.map((l) => (
                    <tr key={l.id} className="border-t border-gray-100">
                      <td className="td font-medium truncate">{l.name}</td>
                      <td className="td text-right text-gray-600 tnum"><Users size={13} className="inline mr-1 text-gray-300" />{l.subscribers}</td>
                      <td className="td text-right space-x-2 whitespace-nowrap">
                        <button className="btn-ghost btn-sm" disabled={sync.isPending} onClick={() => sync.mutate(l.id)}>{sync.isPending ? <Spinner /> : <><RefreshCw size={13} /> Sync customers</>}</button>
                        <button className="btn-ghost btn-sm" onClick={() => setCampaign({ name: '', subject: '', listId: l.id, body: '' })}><Send size={13} /> Campaign</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {sync.data && <div className={`px-5 py-2.5 text-xs ${sync.data.failed ? 'text-amber-700 bg-amber-50' : 'text-emerald-700 bg-emerald-50'}`}>Synced {sync.data.synced} customers{sync.data.failed ? ` — ${sync.data.failed} failed (check Listmonk connection/logs)` : ''}.</div>}
            {sync.error && <div className="px-5 py-2.5 text-xs text-red-700 bg-red-50">{(sync.error as Error).message}</div>}
          </div>

          {campaign && (
            <FormSection title="New campaign" description="Creates a draft in Listmonk — review and send from there."
              actions={<>
                <button className="btn-ghost" onClick={() => setCampaign(null)}>Cancel</button>
                <button className="btn-primary" disabled={createCampaign.isPending || !campaign.name || !campaign.subject} onClick={() => createCampaign.mutate()}>{createCampaign.isPending ? <Spinner className="text-white" /> : 'Create draft'}</button>
              </>}>
              {createCampaign.error && <InlineAlert tone="critical">{(createCampaign.error as Error).message}</InlineAlert>}
              <Field label="Name" htmlFor="c-name"><input id="c-name" className="input" value={campaign.name} onChange={(e) => setCampaign({ ...campaign, name: e.target.value })} /></Field>
              <Field label="Subject" htmlFor="c-subj"><input id="c-subj" className="input" value={campaign.subject} onChange={(e) => setCampaign({ ...campaign, subject: e.target.value })} /></Field>
              <Field label="Body (HTML)" htmlFor="c-body"><textarea id="c-body" className="input min-h-[120px]" value={campaign.body} onChange={(e) => setCampaign({ ...campaign, body: e.target.value })} /></Field>
            </FormSection>
          )}
        </div>
      )}
    </>
  );
}
