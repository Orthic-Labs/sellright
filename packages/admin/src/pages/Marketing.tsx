import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Check, RefreshCw, Send } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, Spinner } from '../components/ui';

interface ListmonkList { id: number; name: string; subscribers: number; type: string; }

export default function Marketing() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const cfgKey = ['lm-config', store?.slug];
  const { data: cfg, isLoading } = useQuery({ queryKey: cfgKey, queryFn: () => api.get<{ configured: boolean; url: string | null }>('/marketing/config') });

  const [form, setForm] = useState({ url: '', apiUser: '', apiToken: '' });
  const connect = useMutation({
    mutationFn: () => api.patch<{ ok: boolean; lists: number }>('/marketing/config', form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: cfgKey }); qc.invalidateQueries({ queryKey: ['lm-lists', store?.slug] }); },
  });

  const lists = useQuery({
    queryKey: ['lm-lists', store?.slug],
    queryFn: () => api.get<{ lists: ListmonkList[] }>('/marketing/lists'),
    enabled: !!cfg?.configured,
  });
  const sync = useMutation({ mutationFn: (listId: number) => api.post<{ synced: number }>('/marketing/sync', { listId }), onSuccess: () => lists.refetch() });

  const [campaign, setCampaign] = useState<{ name: string; subject: string; listId: number; body: string } | null>(null);
  const createCampaign = useMutation({ mutationFn: () => api.post('/marketing/campaigns', campaign), onSuccess: () => setCampaign(null) });

  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader title="Marketing & Email" subtitle="Listmonk — managed right here, no separate login." />

      {!cfg?.configured ? (
        <div className="card p-5 max-w-xl">
          <div className="flex items-center gap-2 mb-3 text-sm font-semibold"><Mail size={16} className="text-brand" /> Connect Listmonk</div>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); connect.mutate(); }}>
            <div><label className="label">Listmonk URL</label><input className="input" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://listmonk.example.com" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">API user</label><input className="input" value={form.apiUser} onChange={(e) => setForm({ ...form, apiUser: e.target.value })} /></div>
              <div><label className="label">API token</label><input className="input" type="password" value={form.apiToken} onChange={(e) => setForm({ ...form, apiToken: e.target.value })} /></div>
            </div>
            {connect.error && <ErrorNote message={(connect.error as Error).message} />}
            <button className="btn-primary" disabled={connect.isPending || !form.url}>{connect.isPending ? <Spinner className="text-white" /> : 'Connect & verify'}</button>
          </form>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="card p-4 flex items-center justify-between">
            <div className="text-sm"><Check size={15} className="inline text-emerald-600 mr-1" /> Connected to <span className="font-mono">{cfg.url}</span></div>
            <button className="text-sm text-gray-400 hover:text-ink" onClick={() => connect.reset()}>Reconfigure</button>
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">Lists</div>
            {lists.isLoading ? <Loading /> : lists.error ? <ErrorNote message={(lists.error as Error).message} /> : (
              <table className="w-full">
                <thead><tr><th className="th">List</th><th className="th text-right">Subscribers</th><th className="th"></th></tr></thead>
                <tbody>
                  {lists.data?.lists.map((l) => (
                    <tr key={l.id} className="border-t border-gray-100">
                      <td className="td font-medium">{l.name}</td>
                      <td className="td text-right text-gray-600">{l.subscribers}</td>
                      <td className="td text-right space-x-2 whitespace-nowrap">
                        <button className="btn-ghost py-1.5 px-2 text-xs" disabled={sync.isPending} onClick={() => sync.mutate(l.id)}>{sync.isPending ? <Spinner /> : <><RefreshCw size={13} /> Sync customers</>}</button>
                        <button className="btn-ghost py-1.5 px-2 text-xs" onClick={() => setCampaign({ name: '', subject: '', listId: l.id, body: '' })}><Send size={13} /> Campaign</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {sync.data && <div className="px-4 py-2 text-xs text-emerald-700 bg-emerald-50">Synced {sync.data.synced} customers.</div>}
          </div>

          {campaign && (
            <div className="card p-4 space-y-3 max-w-xl">
              <div className="text-sm font-semibold">New campaign</div>
              <div><label className="label">Name</label><input className="input" value={campaign.name} onChange={(e) => setCampaign({ ...campaign, name: e.target.value })} /></div>
              <div><label className="label">Subject</label><input className="input" value={campaign.subject} onChange={(e) => setCampaign({ ...campaign, subject: e.target.value })} /></div>
              <div><label className="label">Body (HTML)</label><textarea className="input min-h-[120px]" value={campaign.body} onChange={(e) => setCampaign({ ...campaign, body: e.target.value })} /></div>
              {createCampaign.error && <ErrorNote message={(createCampaign.error as Error).message} />}
              <div className="flex gap-2">
                <button className="btn-primary" disabled={createCampaign.isPending || !campaign.name || !campaign.subject} onClick={() => createCampaign.mutate()}>{createCampaign.isPending ? <Spinner className="text-white" /> : 'Create draft in Listmonk'}</button>
                <button className="btn-ghost" onClick={() => setCampaign(null)}>Cancel</button>
              </div>
              <p className="text-xs text-gray-400">Creates the campaign as a draft in Listmonk; review & send from the campaign (send scheduling stays in Listmonk for safety).</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
