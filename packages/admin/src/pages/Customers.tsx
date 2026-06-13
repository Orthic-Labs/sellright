import { useState } from 'react';
import { useQuery, keepPreviousData, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, Users } from 'lucide-react';
import { api, type Page, type CustomerRow } from '../api';
import { useAuth } from '../auth';
import { money, date, initials } from '../lib/format';
import {
  PageHeader, Pagination, ResourceToolbar, SearchInput, ResourceTable, FormSection, Field,
  InlineAlert, Spinner, EmptyStateActionPanel, type Column,
} from '../components/ui';

export default function Customers() {
  const { store } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const cur = store?.currency ?? 'USD';
  const [form, setForm] = useState<{ email: string; firstName: string; lastName: string } | null>(null);

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['customers', store?.slug, q, page],
    queryFn: () => api.get<Page<CustomerRow>>(`/customers?${new URLSearchParams({ q, page: String(page), pageSize: '25' })}`),
    placeholderData: keepPreviousData,
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/customers', { email: form!.email, firstName: form!.firstName || undefined, lastName: form!.lastName || undefined }),
    onSuccess: (r) => { setForm(null); qc.invalidateQueries({ queryKey: ['customers', store?.slug] }); nav(`/customers/${r.id}`); },
  });
  const name = (c: CustomerRow) => [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';

  const columns: Column<CustomerRow>[] = [
    { key: 'customer', header: 'Customer', render: (c) => (
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-8 w-8 rounded-full bg-brand-light text-brand grid place-items-center text-xs font-semibold shrink-0">{initials(c.email, c.firstName, c.lastName)}</div>
        <span className="font-medium truncate">{name(c)}</span>
      </div>
    )},
    { key: 'email', header: 'Email', render: (c) => <span className="text-gray-600 truncate block">{c.email}</span> },
    { key: 'orders', header: 'Orders', align: 'center', width: '12%', render: (c) => <span className="tnum text-gray-500">{c.orders}</span> },
    { key: 'spent', header: 'Spent', align: 'right', width: '15%', render: (c) => <span className="tnum font-medium">{money(c.spent, cur)}</span> },
    { key: 'joined', header: 'Joined', width: '16%', render: (c) => <span className="text-gray-500">{date(c.createdAt)}</span> },
  ];

  return (
    <>
      <PageHeader title="Customers" subtitle={data ? `${data.total} total` : undefined} actions={
        <button className="btn-primary whitespace-nowrap" onClick={() => setForm(form ? null : { email: '', firstName: '', lastName: '' })}><Plus size={16} /> New customer</button>
      } />

      {form && (
        <div className="mb-4">
          <FormSection title="New customer" description="Create a customer profile. They can be attached to orders and marketing lists."
            actions={
              <>
                <button className="btn-ghost" onClick={() => setForm(null)}>Cancel</button>
                <button className="btn-primary" disabled={create.isPending || !form.email.trim()} onClick={() => create.mutate()}>{create.isPending ? <Spinner className="text-white" /> : 'Create customer'}</button>
              </>
            }>
            {create.error && <InlineAlert tone="critical">{(create.error as Error).message}</InlineAlert>}
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="sm:col-span-1"><Field label="Email" htmlFor="c-email"><input id="c-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field></div>
              <Field label="First name" htmlFor="c-first"><input id="c-first" className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
              <Field label="Last name" htmlFor="c-last"><input id="c-last" className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
            </div>
          </FormSection>
        </div>
      )}

      <ResourceToolbar
        right={<SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search name or email" />}
      />

      <ResourceTable
        columns={columns}
        rows={data?.items}
        rowKey={(c) => c.id}
        onRowClick={(c) => nav(`/customers/${c.id}`)}
        loading={isLoading}
        isFetching={isFetching}
        error={error ? (error as Error).message : null}
        onRetry={() => refetch()}
        empty={q
          ? <EmptyStateActionPanel icon={<Users size={22} />} title="No matching customers" description="No customers match your search." actions={[{ label: 'Clear search', variant: 'ghost', onClick: () => { setQ(''); setPage(1); } }]} />
          : <EmptyStateActionPanel icon={<Users size={22} />} title="No customers yet" description="Customers are created automatically at checkout, or you can add one manually." actions={[{ label: 'New customer', icon: <Plus size={16} />, onClick: () => setForm({ email: '', firstName: '', lastName: '' }) }]} />}
      />

      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
