import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { api, type Page } from '../api';
import { useAuth } from '../auth';
import { date } from '../lib/format';
import {
  Badge, PageHeader, Pagination, Tabs, ResourceToolbar, ResourceTable,
  EmptyStateActionPanel, type Column, type TabDef,
} from '../components/ui';

interface SubscriptionRow {
  id: string;
  status: string;
  priceId: string | null;
  stripeSubscriptionId: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  email: string | null;
}

const TABS: TabDef[] = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'past_due', label: 'Past due' },
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'canceled', label: 'Canceled' },
];

export default function Subscriptions() {
  const { store } = useAuth();
  const [tab, setTab] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['subscriptions', store?.slug, tab, page],
    queryFn: () => api.get<Page<SubscriptionRow>>(`/subscriptions?${new URLSearchParams({ status: tab, page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });

  function changeTab(t: string) { setTab(t); setPage(1); }

  const columns: Column<SubscriptionRow>[] = [
    { key: 'status', header: 'Status', width: '14%', render: (r) => <Badge value={r.status} /> },
    { key: 'customer', header: 'Customer', render: (r) => <span className="text-gray-600 truncate block">{r.email ?? '—'}</span> },
    { key: 'plan', header: 'Plan', width: '22%', render: (r) => <span className="font-mono text-xs text-gray-600">{r.priceId ?? r.stripeSubscriptionId}</span> },
    { key: 'period', header: 'Renews', width: '16%', render: (r) => (
      <span className="text-gray-500">
        {r.currentPeriodEnd ? date(r.currentPeriodEnd) : '—'}
        {r.cancelAtPeriodEnd && <span className="ml-1.5 align-middle text-[10px] uppercase font-semibold text-warning bg-warning-soft rounded px-1 py-0.5">cancels</span>}
      </span>
    ) },
    { key: 'created', header: 'Started', align: 'right', width: '16%', render: (r) => <span className="text-gray-500">{date(r.createdAt)}</span> },
  ];

  return (
    <>
      <PageHeader title="Subscriptions" subtitle={data ? `${data.total} total` : undefined} />

      <ResourceToolbar left={<Tabs tabs={TABS} value={tab} onChange={changeTab} />} />

      <ResourceTable
        columns={columns}
        rows={data?.items}
        rowKey={(r) => r.id}
        loading={isLoading}
        isFetching={isFetching}
        error={error ? (error as Error).message : null}
        onRetry={() => refetch()}
        empty={<EmptyStateActionPanel icon={<CreditCard size={22} />} title="No subscriptions yet" description="Recurring plans purchased by customers will appear here." />}
      />

      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
