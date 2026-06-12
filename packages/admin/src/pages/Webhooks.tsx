import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Copy, Check } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner } from '../components/ui';

interface WebhookEndpoint {
  id: string;
  url: string;
  topics: string[];
  enabled: boolean;
}

interface CreateResponse {
  id: string;
  secret: string;
}

const TOPIC_OPTIONS = [
  'order.created',
  'order.paid',
  'order.shipped',
  'order.refunded',
  '*',
];

function SecretCallout({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-800 mb-1">Copy your signing secret — it won't be shown again</p>
      <p className="text-xs text-amber-700 mb-3">Store this secret somewhere safe. Use it to verify webhook payloads by checking the <code className="font-mono bg-amber-100 px-1 rounded">X-Webhook-Signature</code> header on incoming requests.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-xs bg-white border border-amber-200 rounded px-3 py-2 text-amber-900 break-all select-all">{secret}</code>
        <button
          className="btn-ghost flex items-center gap-1.5 text-amber-700 border border-amber-300 hover:bg-amber-100 shrink-0"
          onClick={copy}
          type="button"
        >
          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <button className="mt-3 text-xs text-amber-600 underline" type="button" onClick={onDismiss}>I've saved it — dismiss</button>
    </div>
  );
}

export default function WebhooksPage() {
  const { store } = useAuth();
  const qc = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [formUrl, setFormUrl] = useState('');
  const [formTopics, setFormTopics] = useState('');
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const key = ['webhooks', store?.slug];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: WebhookEndpoint[] }>('/admin/webhooks'),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const parseTopics = (raw: string): string[] =>
    raw.split(',').map((t) => t.trim()).filter(Boolean);

  const create = useMutation({
    mutationFn: () =>
      api.post<CreateResponse>('/admin/webhooks', {
        url: formUrl.trim(),
        topics: parseTopics(formTopics),
      }),
    onSuccess: (res) => {
      setShowForm(false);
      setFormUrl('');
      setFormTopics('');
      setNewSecret(res.secret);
      invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: (w: WebhookEndpoint) =>
      api.patch(`/admin/webhooks/${w.id}`, { enabled: !w.enabled }),
    onSuccess: invalidate,
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/admin/webhooks/${id}`),
    onSuccess: () => { setDeleteConfirm(null); invalidate(); },
  });

  return (
    <>
      <PageHeader
        title="Webhooks"
        subtitle="Receive HTTP POST notifications when events occur in your store."
        actions={
          <button
            className="btn-primary"
            onClick={() => { setShowForm((v) => !v); setNewSecret(null); }}
          >
            <Plus size={16} /> Add endpoint
          </button>
        }
      />

      {newSecret && (
        <SecretCallout secret={newSecret} onDismiss={() => setNewSecret(null)} />
      )}

      {showForm && (
        <form
          className="card p-4 mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
        >
          <div className="flex-1 min-w-52">
            <label className="label">Endpoint URL</label>
            <input
              className="input w-full"
              type="url"
              placeholder="https://example.com/hooks/sellright"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              required
            />
          </div>
          <div className="flex-1 min-w-64">
            <label className="label">
              Topics{' '}
              <span className="text-gray-400 font-normal">
                (comma-separated — e.g. <code className="font-mono">order.created,order.paid</code> or <code className="font-mono">*</code>)
              </span>
            </label>
            <input
              className="input w-full"
              placeholder="order.created, order.paid, *"
              value={formTopics}
              onChange={(e) => setFormTopics(e.target.value)}
              required
            />
            <div className="flex flex-wrap gap-1 mt-1">
              {TOPIC_OPTIONS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="text-xs px-2 py-0.5 rounded-full border border-gray-200 hover:bg-gray-50 font-mono"
                  onClick={() => {
                    const existing = parseTopics(formTopics);
                    if (!existing.includes(t)) {
                      setFormTopics(existing.length ? `${formTopics.trimEnd().replace(/,\s*$/, '')}, ${t}` : t);
                    }
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="btn-primary"
              type="submit"
              disabled={!formUrl.trim() || !formTopics.trim() || create.isPending}
            >
              {create.isPending ? <Spinner className="text-white" /> : 'Save'}
            </button>
            <button
              className="btn-ghost"
              type="button"
              onClick={() => { setShowForm(false); setFormUrl(''); setFormTopics(''); }}
            >
              Cancel
            </button>
          </div>
          {create.error && (
            <div className="w-full">
              <ErrorNote message={(create.error as Error).message} />
            </div>
          )}
        </form>
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorNote message={(error as Error).message} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No webhook endpoints"
            hint="Add an endpoint to start receiving event notifications."
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">URL</th>
                <th className="th">Topics</th>
                <th className="th">Status</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((w) => (
                <tr key={w.id} className="border-t border-gray-100">
                  <td className="td font-mono text-sm break-all max-w-xs">{w.url}</td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1">
                      {w.topics.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-mono ring-1 ring-inset bg-gray-50 text-gray-600 ring-gray-500/20"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="td">
                    <button
                      onClick={() => toggle.mutate(w)}
                      disabled={toggle.isPending}
                      title={w.enabled ? 'Click to disable' : 'Click to enable'}
                    >
                      <Badge value={w.enabled ? 'active' : 'draft'} />
                    </button>
                  </td>
                  <td className="td text-right">
                    {deleteConfirm === w.id ? (
                      <span className="flex items-center justify-end gap-2 text-sm">
                        <span className="text-gray-500">Delete?</span>
                        <button
                          className="text-red-600 font-medium hover:underline"
                          onClick={() => del.mutate(w.id)}
                          disabled={del.isPending}
                        >
                          {del.isPending ? <Spinner /> : 'Yes'}
                        </button>
                        <button
                          className="text-gray-400 hover:text-gray-600"
                          onClick={() => setDeleteConfirm(null)}
                        >
                          No
                        </button>
                      </span>
                    ) : (
                      <button
                        className="text-gray-300 hover:text-red-600"
                        onClick={() => setDeleteConfirm(w.id)}
                        title="Delete endpoint"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
