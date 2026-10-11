import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, KeyRound, RefreshCw } from 'lucide-react';
import { api, type AgentRow } from '../api';
import { useAuth } from '../auth';
import { EmptyState, ErrorNote, Loading, Spinner } from '../components/ui';
import { AGENT_ROLES, ROLE_LABELS, type Role } from './staff-permissions';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function AgentAccess() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const canManage = store?.role === 'owner' || store?.role === 'manager';
  const key = ['agents', store?.slug];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ items: AgentRow[] }>('/agents'), enabled: canManage });
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const invalidate = () => { for (const k of [key, ['staff', store?.slug]]) void qc.invalidateQueries({ queryKey: k }); };
  const create = useMutation({ mutationFn: () => api.post<{ token: string }>('/agents', { name, role }), onSuccess: (r) => { setIssued({ name, token: r.token }); setName(''); invalidate(); } });
  const rotate = useMutation({ mutationFn: (a: AgentRow) => api.post<{ token: string }>(`/agents/${a.adminUserId}/rotate`), onSuccess: (r, a) => { setIssued({ name: a.name, token: r.token }); invalidate(); } });
  if (!canManage) return null;
  const items = q.data?.items ?? [];
  const err = (q.error ?? create.error ?? rotate.error) as Error | null;
  return (
    <div className="card overflow-hidden mb-5">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-2"><Bot size={15} /> Agent access</h2>
        <span className="text-xs text-gray-400">API tokens for automation. Same roles and grants as staff; never delete, cancel, refund or manage staff. Edit role and grants in the staff list above.</span>
      </div>
      {issued && (
        <div className="m-4 p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm" role="status">
          <p className="font-medium mb-1">Token for “{issued.name}” — shown once. Copy it now.</p>
          <code className="block break-all text-xs bg-white border border-amber-200 rounded-sm p-2 select-all" data-testid="agent-token">{issued.token}</code>
          <button className="btn-ghost btn-sm mt-2" onClick={() => setIssued(null)}>Done</button>
        </div>
      )}
      <div className="p-4 flex gap-2 items-center border-b border-gray-100">
        <input className="input max-w-xs" placeholder="Agent name (e.g. Ops bot)" aria-label="Agent name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="input w-auto" aria-label="Agent role" value={role} onChange={(e) => setRole(e.target.value as Role)}>{AGENT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
        <button className="btn-primary btn-sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>{create.isPending ? <Spinner className="text-white" /> : <><KeyRound size={14} /> Create agent</>}</button>
      </div>
      {err && <div className="p-4"><ErrorNote message={err.message} /></div>}
      {q.isLoading ? <Loading /> : items.length === 0 ? <EmptyState title="No agents" hint="Create one to get an API token." /> : (
        <table className="w-full">
          <thead><tr><th className="th">Agent</th><th className="th">Identity</th><th className="th">Role</th><th className="th">Last used</th><th className="th">Created</th><th className="th" /></tr></thead>
          <tbody>{items.map((a) => (
            <tr key={a.id}>
              <td className="td font-medium">{a.name}</td>
              <td className="td text-xs text-gray-500">{a.email}</td>
              <td className="td text-xs">{ROLE_LABELS[a.role as Role] ?? a.role}</td>
              <td className="td text-xs">{fmt(a.lastUsedAt)}</td>
              <td className="td text-xs">{fmt(a.createdAt)}{a.createdBy ? ` by ${a.createdBy}` : ''}</td>
              <td className="td text-right whitespace-nowrap">
                <button className="btn-ghost btn-sm" disabled={rotate.isPending} onClick={() => rotate.mutate(a)} title="Revoke the current token and issue a new one"><RefreshCw size={13} /> Rotate</button>
              </td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}
