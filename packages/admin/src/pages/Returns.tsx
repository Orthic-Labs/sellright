import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner, Pagination } from '../components/ui';
import { date, money } from '../lib/format';
import { useToast } from '../components/Toast';

interface ReturnRequest {
  id: string;
  status: 'requested' | 'approved' | 'rejected' | 'received' | 'refunded';
  reason: string | null;
  orderCode: string;
  createdAt: string;
  /** Not sent by the list endpoint today; shown in the confirm step only when present. */
  refundAmount?: number | null;
}

interface ApproveState {
  id: string;
  restock: boolean;
}

export default function ReturnsPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cur = store?.currency ?? 'USD';

  const [approving, setApproving] = useState<ApproveState | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ['returns', store?.slug, page],
    queryFn: () => api.get<{ items: ReturnRequest[]; total: number; page: number; pageSize: number }>(`/returns?page=${page}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['returns', store?.slug] });

  const approve = useMutation({
    mutationFn: (s: ApproveState) =>
      api.post<{ id: string; refunded: number; state: string }>(`/returns/${s.id}/approve`, { restock: s.restock }),
    onSuccess: (d) => {
      setApproving(null);
      setApproveError(null);
      invalidate();
      toast.success('Return approved', typeof d?.refunded === 'number' ? `Refund of ${money(d.refunded, cur)} reserved.` : undefined);
    },
    onError: (e: Error) => { setApproveError(e.message); toast.error('Could not approve return', e.message); },
  });

  const reject = useMutation({
    mutationFn: (id: string) => api.post<{ id: string }>(`/returns/${id}/reject`),
    onSuccess: () => {
      setRejecting(null);
      setRejectError(null);
      invalidate();
      toast.success('Return rejected');
    },
    onError: (e: Error) => { setRejectError(e.message); toast.error('Could not reject return', e.message); },
  });

  return (
    <>
      <PageHeader
        title="Returns"
        subtitle="Review and action customer return requests."
      />

      {approveError && (
        <div className="mb-4">
          <ErrorNote message={approveError} />
        </div>
      )}
      {rejectError && (
        <div className="mb-4">
          <ErrorNote message={rejectError} />
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorNote message={(error as Error).message} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No return requests" hint="Customer return requests will appear here." />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Order</th>
                <th className="th">Status</th>
                <th className="th">Reason</th>
                <th className="th">Requested</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="td font-mono font-medium">{r.orderCode}</td>
                  <td className="td">
                    <Badge value={r.status} />
                  </td>
                  <td className="td text-gray-500 max-w-xs truncate">{r.reason ?? '—'}</td>
                  <td className="td text-gray-500">{date(r.createdAt)}</td>
                  <td className="td">
                    {r.status === 'requested' && (
                      <div className="flex items-center gap-2 justify-end">
                        {approving?.id === r.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-600">
                              Approve return for <span className="font-mono">{r.orderCode}</span>
                              {typeof r.refundAmount === 'number' ? <> and refund {money(r.refundAmount, cur)}</> : null}?
                            </span>
                            <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
                              <input
                                type="checkbox"
                                className="rounded-sm border-gray-300"
                                checked={approving.restock}
                                onChange={(e) =>
                                  setApproving({ id: r.id, restock: e.target.checked })
                                }
                              />
                              Restock
                            </label>
                            <button
                              className="btn-primary text-xs py-1 px-2"
                              disabled={approve.isPending}
                              onClick={() => approve.mutate(approving)}
                            >
                              {approve.isPending ? <Spinner className="text-white" /> : 'Confirm'}
                            </button>
                            <button
                              className="btn-ghost text-xs py-1 px-2"
                              onClick={() => { setApproving(null); setApproveError(null); }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : rejecting === r.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-600">Reject return for <span className="font-mono">{r.orderCode}</span>?</span>
                            <button
                              className="btn-danger text-xs py-1 px-2"
                              disabled={reject.isPending}
                              onClick={() => reject.mutate(r.id)}
                            >
                              {reject.isPending ? <Spinner className="text-white" /> : 'Confirm reject'}
                            </button>
                            <button
                              className="btn-ghost text-xs py-1 px-2"
                              onClick={() => { setRejecting(null); setRejectError(null); }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              className="btn-primary text-xs py-1 px-2"
                              onClick={() => { setApproving({ id: r.id, restock: false }); setRejecting(null); }}
                            >
                              Approve
                            </button>
                            <button
                              className="btn-danger text-xs py-1 px-2"
                              onClick={() => { setRejecting(r.id); setApproving(null); }}
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && <Pagination page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
