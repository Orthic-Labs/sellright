import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, Pencil } from 'lucide-react';
import { api, type CustomerDetail } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { money, date, dateTime } from '../lib/format';
import { PageHeader, StatusBadge, FormSection, InlineAlert, ErrorState, Loading, Field, Spinner, EmptyState, KpiCard } from '../components/ui';

export default function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { store } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const cur = store?.currency ?? 'USD';

  const { data: c, isLoading, error } = useQuery({
    queryKey: ['customer', store?.slug, id],
    queryFn: () => api.get<CustomerDetail>(`/customers/${id}`),
  });
  const [edit, setEdit] = useState<{ firstName: string; lastName: string; phone: string; tags: string } | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch(`/customers/${id}`, { firstName: edit!.firstName || null, lastName: edit!.lastName || null, phone: edit!.phone || null, tags: edit!.tags ? edit!.tags.split(',').map((t) => t.trim()).filter(Boolean) : null }),
    onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['customer', store?.slug, id] }); toast.success('Customer saved'); },
    onError: (e) => toast.error('Save failed', (e as Error).message),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState title="Couldn't load this customer" message={(error as Error).message} onRetry={() => qc.invalidateQueries({ queryKey: ['customer', store?.slug, id] })} />;
  if (!c) return null;

  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email;

  return (
    <>
      <Link to="/customers" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Customers</Link>
      <PageHeader
        title={name}
        subtitle={`${c.email} · joined ${date(c.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            {c.emailVerified && <StatusBadge value="active" label="Verified" />}
            <button className="btn-ghost" onClick={() => setEdit({ firstName: c.firstName ?? '', lastName: c.lastName ?? '', phone: c.phone ?? '', tags: (c as any).tags?.join(', ') ?? '' })}><Pencil size={15} /> Edit</button>
          </div>
        }
      />
      <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Total spent" value={money(c.spent, cur)} hint={`${c.orderCount} order${c.orderCount === 1 ? '' : 's'}`} />
        <KpiCard label="Orders" value={<span className="tnum">{c.orderCount}</span>} hint="paid + refunded" />
        <KpiCard label="Avg order" value={money(c.orderCount ? Math.round(c.spent / c.orderCount) : 0, cur)} hint="paid + refunded" />
        <KpiCard label="Addresses" value={<span className="tnum">{c.addresses.length}</span>} hint="on file" />
      </div>

      {edit && (
        <FormSection title="Edit profile" description="Name, phone, and tags are visible to the customer on their next visit.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name"><input className="input" value={edit.firstName} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} /></Field>
            <Field label="Last name"><input className="input" value={edit.lastName} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} /></Field>
          </div>
          <Field label="Phone"><input className="input" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
          <Field label="Tags (comma-separated)" hint="Used to segment campaigns and discount rules."><input className="input" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} placeholder="vip, wholesale" /></Field>
          {save.error && <InlineAlert tone="critical">{(save.error as Error).message}</InlineAlert>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
            <button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </FormSection>
      )}

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <FormSection title="Order history" description={`${c.orders.length} most recent orders`}>
            {c.orders.length === 0 ? <EmptyState title="No orders yet" hint="Orders placed by this customer will appear here." /> : (
              <table className="w-full">
                <thead><tr><th className="th">Order</th><th className="th">Date</th><th className="th">Status</th><th className="th text-right">Total</th></tr></thead>
                <tbody>
                  {c.orders.map((o) => (
                    <tr key={o.code} className="row-link border-t border-gray-100 first:border-0" onClick={() => nav(`/orders/${o.code}`)}>
                      <td className="td font-medium">{o.code}</td>
                      <td className="td text-gray-500">{dateTime(o.placedAt ?? o.createdAt)}</td>
                      <td className="td"><StatusBadge value={o.state} /></td>
                      <td className="td text-right font-medium">{money(o.grandTotal, o.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </FormSection>
        </div>

        <div className="space-y-5">
          <FormSection title="Contact">
            <div className="text-sm space-y-1">
              <div><span className="text-gray-500">Email:</span> <span className="font-medium break-all">{c.email}</span></div>
              {c.phone && <div><span className="text-gray-500">Phone:</span> <span className="font-medium">{c.phone}</span></div>}
              <div className="flex items-center gap-1.5"><span className="text-gray-500">Verified:</span> {c.emailVerified ? <span className="text-emerald-600 inline-flex items-center gap-1"><BadgeCheck size={13} /> Yes</span> : <span className="text-gray-500">No</span>}</div>
              <div><span className="text-gray-500">Joined:</span> <span className="font-medium">{date(c.createdAt)}</span></div>
            </div>
          </FormSection>

          <FormSection title="Addresses" description={`${c.addresses.length} on file`}>
            {c.addresses.length === 0 ? <EmptyState title="No addresses on file" /> : c.addresses.map((a, i) => (
              <div key={i} className="text-sm text-gray-600 mb-3 last:mb-0 pb-3 last:pb-0 border-b border-gray-100 last:border-0">
                {a.fullName && <div className="font-medium text-ink">{a.fullName}</div>}
                <div className="truncate">{[a.line1, a.line2].filter(Boolean).join(', ')}</div>
                <div>{[a.city, a.province, a.postalCode].filter(Boolean).join(' ')}</div>
                <div>{a.country}</div>
              </div>
            ))}
          </FormSection>
        </div>
      </div>
    </>
  );
}
