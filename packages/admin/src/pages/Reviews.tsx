import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Page } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { Badge, EmptyState, ErrorState, Field, FormSection, InlineAlert, Loading, PageHeader, Pagination, SearchInput, Spinner, Tabs } from '../components/ui';
import { dateTime } from '../lib/format';

interface ReviewRow {
  id: string; productId: string; productName: string | null; productSlug: string | null; customerId: string | null;
  authorName: string; authorEmail: string; rating: number; title: string | null; body: string;
  status: 'pending' | 'approved' | 'rejected'; verifiedBuyer: boolean; reply: string | null; repliedAt: string | null;
  bonusPoints: number; moderatedBy: string | null; moderatedAt: string | null; createdAt: string;
}
interface ReviewPage extends Page<ReviewRow> { counts: { pending: number; approved: number; rejected: number } }
interface ReviewSettings { enabled: boolean; allowGuests: boolean; autoApprove: boolean; requirePurchase: boolean }

const Stars = ({ n }: { n: number }) => <span aria-label={`${n} out of 5`} className="tnum text-warning">{'★'.repeat(n)}<span className="text-gray-300">{'★'.repeat(5 - n)}</span></span>;

function ReviewSettingsPanel() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['review-settings', store?.slug];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<ReviewSettings>('/reviews-settings') });
  const save = useMutation({
    mutationFn: (s: ReviewSettings) => api.put<ReviewSettings>('/reviews-settings', s),
    onSuccess: (next) => { qc.setQueryData(key, next); toast.success('Review settings saved'); },
    onError: (e) => toast.error('Save failed', (e as Error).message),
  });
  if (!data) return null;
  const toggle = (k: keyof ReviewSettings, label: string, hint: string) => (
    <label className="flex items-start gap-2 text-sm py-1">
      <input type="checkbox" className="mt-1" checked={data[k]} disabled={save.isPending} onChange={(e) => save.mutate({ ...data, [k]: e.target.checked })} />
      <span>{label}<span className="block text-xs text-gray-500">{hint}</span></span>
    </label>
  );
  return (
    <FormSection title="Review settings" description="Changes save immediately.">
      {toggle('enabled', 'Accept reviews', 'Turn off to hide the review form and the review list on product pages.')}
      {toggle('autoApprove', 'Publish reviews without moderation', 'Not recommended: reviews and the review bonus go live immediately.')}
      {toggle('requirePurchase', 'Only buyers can review', 'Requires a paid order containing the product.')}
      {toggle('allowGuests', 'Allow guest reviews', 'Guests must enter an order code and the matching email, which proves the purchase.')}
    </FormSection>
  );
}

function ReplyBox({ row, onDone }: { row: ReviewRow; onDone: () => void }) {
  const [text, setText] = useState(row.reply ?? '');
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.put(`/reviews/${row.id}/reply`, { reply: text.trim() ? text.trim() : null }),
    onSuccess: () => { toast.success(text.trim() ? 'Reply saved' : 'Reply removed'); onDone(); },
    onError: (e) => toast.error('Could not save reply', (e as Error).message),
  });
  return (
    <div className="mt-2">
      <Field label="Public reply"><textarea className="input" rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <button className="btn-ghost text-xs mt-1" disabled={save.isPending || text.trim() === (row.reply ?? '')} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : 'Save reply'}</button>
    </div>
  );
}

export default function ReviewsPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const key = ['reviews', store?.slug, status, q, page];
  const { data, isLoading, error } = useQuery({
    queryKey: key, placeholderData: keepPreviousData,
    queryFn: () => api.get<ReviewPage>(`/reviews?${new URLSearchParams({ status, q, page: String(page), pageSize: '20' })}`),
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['reviews', store?.slug] }); };
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' | 'delete' }) =>
      action === 'delete' ? api.del<{ ok: true; bonusPoints: number }>(`/reviews/${id}`) : api.post<{ ok: true; bonusPoints: number }>(`/reviews/${id}/${action}`, {}),
    onSuccess: (res, v) => {
      toast.success(v.action === 'approve' ? (res.bonusPoints ? `Approved, ${res.bonusPoints} points awarded` : 'Approved') : v.action === 'reject' ? 'Rejected' : 'Deleted');
      refresh();
    },
    onError: (e) => toast.error('Action failed', (e as Error).message),
  });

  const counts = data?.counts;
  return (
    <>
      <PageHeader title="Reviews" subtitle="Moderate product reviews. Approving a review publishes it and awards the review bonus once." />
      <Tabs
        value={status}
        onChange={(k) => { setStatus(k as typeof status); setPage(1); }}
        tabs={[
          { key: 'pending', label: 'Pending', count: counts?.pending },
          { key: 'approved', label: 'Approved', count: counts?.approved },
          { key: 'rejected', label: 'Rejected', count: counts?.rejected },
          { key: 'all', label: 'All' },
        ]}
      />
      <div className="my-3"><SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search reviews" /></div>
      {isLoading ? <Loading /> : error ? <ErrorState message={(error as Error).message} onRetry={refresh} /> : !data || data.items.length === 0 ? (
        <EmptyState title={status === 'pending' ? 'No reviews waiting for moderation' : 'No reviews'} />
      ) : (
        <div className="space-y-3">
          {data.items.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Stars n={r.rating} />
                <span className="font-medium">{r.title || '(no title)'}</span>
                <Badge value={r.status} tone={r.status === 'approved' ? 'positive' : r.status === 'rejected' ? 'critical' : 'attention'} />
                {r.verifiedBuyer && <Badge value="verified" label="Verified buyer" tone="info" />}
                {r.bonusPoints > 0 && <Badge value="bonus" label={`${r.bonusPoints} points awarded`} tone="neutral" />}
              </div>
              <p className="text-sm mt-2 whitespace-pre-wrap">{r.body}</p>
              <p className="text-xs text-gray-500 mt-2">
                {r.authorName} · {r.authorEmail} · {r.productName ?? 'Deleted product'} · {dateTime(r.createdAt)}
                {r.customerId ? '' : ' · guest'}
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {r.status !== 'approved' && <button className="btn-primary text-xs" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'approve' })}>Approve</button>}
                {r.status !== 'rejected' && <button className="btn-ghost text-xs" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'reject' })}>Reject</button>}
                <button className="btn-ghost text-xs text-critical" disabled={act.isPending} onClick={() => { if (window.confirm('Delete this review permanently?')) act.mutate({ id: r.id, action: 'delete' }); }}>Delete</button>
              </div>
              <ReplyBox key={r.id + (r.reply ?? '')} row={r} onDone={refresh} />
            </div>
          ))}
          <Pagination page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </div>
      )}
      <div className="mt-6"><ReviewSettingsPanel /></div>
      {act.error && <InlineAlert tone="critical">{(act.error as Error).message}</InlineAlert>}
    </>
  );
}
