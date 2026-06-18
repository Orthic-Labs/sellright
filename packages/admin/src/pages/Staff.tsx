import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UserMinus, RefreshCw, Copy, Check } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { PageHeader, Loading, ErrorNote, EmptyState, Badge, Spinner } from '../components/ui';

// ── local types ──────────────────────────────────────────────────────────────

type Role = 'owner' | 'manager' | 'staff' | 'read_only';
const ROLES: Role[] = ['owner', 'manager', 'staff', 'read_only'];
const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', manager: 'Manager', staff: 'Staff', read_only: 'Read-only' };
const ROLE_DESC: Record<Role, string> = {
  owner: 'Full access, including billing, staff, and store deletion.',
  manager: 'Manage products, orders, customers, settings, and staff. No billing.',
  staff: 'Day-to-day operations. Extra capabilities granted per-action below.',
  read_only: 'View-only access. Cannot make changes.',
};

// The full set of per-action permission keys gated by requirePermission() across the API.
// MUST stay in lockstep with the server-side UI_PERMISSION_KEYS allow-list —
// the server rejects unknown keys, and the matrix only renders known keys.
const PERMISSION_ACTIONS: { key: string; label: string; hint: string }[] = [
  { key: 'giftcards', label: 'Gift cards', hint: 'Create and manage gift card codes' },
  { key: 'webhooks', label: 'Webhooks', hint: 'Create, update and delete webhook endpoints' },
];
const UI_PERMISSION_KEYS = PERMISSION_ACTIONS.map((p) => p.key);
const isUiPermissionKey = (k: string): k is typeof UI_PERMISSION_KEYS[number] =>
  (UI_PERMISSION_KEYS as readonly string[]).includes(k);

interface StaffMember {
  adminUserId: string;
  email: string;
  role: Role;
  createdAt: string;
  isYou: boolean;
  /** Per-action grants stored on admin_user_store.permissions. The server
   *  preserves any unknown keys; the UI only knows the keys in PERMISSION_ACTIONS
   *  but we still surface the rest as "other grants" so they never appear
   *  "lost" after a save. */
  permissions?: Record<string, boolean> | null;
}

interface Invite {
  id: string;
  email: string;
  role: Role;
  acceptedAt: string | null;
  expiresAt: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isPrivileged(role: Role) {
  return role === 'owner' || role === 'manager';
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button className="btn-ghost py-1 px-2 flex items-center gap-1 text-xs" onClick={copy} title="Copy token">
      {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ── sub-sections ──────────────────────────────────────────────────────────────

interface PermissionsMatrixProps {
  member: StaffMember;
  onSave: () => void;
}

function PermissionsMatrix({ member, onSave }: PermissionsMatrixProps) {
  const existing = member.permissions ?? {};
  const [perms, setPerms] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const k of UI_PERMISSION_KEYS) init[k] = !!existing[k];
    return init;
  });
  // Reset local checkbox state when the active member changes OR when the
  // server data refreshes (e.g. after save). This keeps the editor in sync
  // with what the API will actually persist.
  useEffect(() => {
    const permsSource = member.permissions ?? {};
    const next: Record<string, boolean> = {};
    for (const k of UI_PERMISSION_KEYS) next[k] = !!permsSource[k];
    setPerms(next);
  }, [member.adminUserId, member.permissions]);
  const [open, setOpen] = useState(false);

  const save = useMutation({
    mutationFn: () => api.put<{ adminUserId: string; permissions: Record<string, boolean> }>(`/staff/${member.adminUserId}/permissions`, { permissions: perms }),
    onSuccess: (res) => { setOpen(false); onSave(); void res; },
  });

  if (isPrivileged(member.role)) {
    return (
      <div className="text-xs text-gray-400 italic">
        All permissions — {ROLE_LABELS[member.role]}s inherit full access.
      </div>
    );
  }

  // How many known UI grants + how many unknown grants does this member have?
  const knownGrants = UI_PERMISSION_KEYS.filter((k) => !!existing[k]).length;
  const unknownGrants = Object.keys(existing).filter((k) => !isUiPermissionKey(k) && !!existing[k]);

  return (
    <div>
      {!open ? (
        <button className="btn-ghost py-1 text-xs flex items-center gap-1" onClick={() => setOpen(true)}>
          <ShieldCheck size={13} /> Permissions
          {knownGrants + unknownGrants.length > 0 && (
            <span className="ml-1 tnum text-[11px] text-gray-400">{knownGrants + unknownGrants.length}</span>
          )}
        </button>
      ) : (
        <div className="mt-2 space-y-2 border border-gray-100 rounded-lg p-3 bg-gray-50">
          <p className="text-xs font-medium text-gray-600 mb-1">Per-action permissions</p>
          {PERMISSION_ACTIONS.map(({ key, label, hint }) => (
            <label key={key} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand"
                checked={!!perms[key]}
                onChange={(e) => setPerms({ ...perms, [key]: e.target.checked })}
              />
              <span className="font-medium">{label}</span>
              <span className="text-gray-400">— {hint}</span>
            </label>
          ))}
          {unknownGrants.length > 0 && (
            <p className="text-xs text-gray-500 pt-1 border-t border-gray-200 mt-2">
              <span className="font-medium">Other grants:</span>{' '}
              {unknownGrants.join(', ')} — preserved automatically when you save.
            </p>
          )}
          {knownGrants === 0 && unknownGrants.length === 0 && (
            <p className="text-xs text-gray-400 italic">No extra permissions granted.</p>
          )}
          {save.error && <ErrorNote message={(save.error as Error).message} />}
          <div className="flex gap-2 pt-1">
            <button className="btn-primary py-1 text-xs" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner className="text-white" /> : 'Save'}
            </button>
            <button className="btn-ghost py-1 text-xs" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function StaffPage() {
  const { store } = useAuth();
  const qc = useQueryClient();

  const staffKey = ['staff', store?.slug];
  const invitesKey = ['staff-invites', store?.slug];

  const staffQ = useQuery({ queryKey: staffKey, queryFn: () => api.get<{ items: StaffMember[] }>('/staff') });
  const invitesQ = useQuery({ queryKey: invitesKey, queryFn: () => api.get<{ items: Invite[] }>('/staff/invites') });

  // Per-member permissions (loaded lazily via a local map)
  // We keep a Record of permissions per adminUserId loaded from the staff list.
  // The staff list endpoint doesn't return permissions, so we track what has been
  // returned by the PUT endpoint or what is visible via the role.
  // For the matrix we start from an empty map and the user checks boxes.
  // (The API stores it in adminUserStore.permissions — not exposed in GET /staff yet.)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: staffKey });
    void qc.invalidateQueries({ queryKey: invitesKey });
  };

  // ── invite form state ──
  const [inviteForm, setInviteForm] = useState<{ email: string; role: Role } | null>(null);
  const [inviteResult, setInviteResult] = useState<{ token: string; acceptUrl: string } | null>(null);

  const sendInvite = useMutation({
    mutationFn: () => api.post<{ id: string; token: string; acceptUrl: string }>('/staff/invites', inviteForm),
    onSuccess: (r) => { setInviteResult({ token: r.token, acceptUrl: r.acceptUrl }); setInviteForm(null); invalidate(); },
  });

  // ── role change ──
  const changeRole = useMutation({
    mutationFn: (p: { id: string; role: Role }) => api.patch(`/staff/${p.id}`, { role: p.role }),
    onSuccess: invalidate,
  });

  // ── revoke sessions ──
  const revokeSessions = useMutation({
    mutationFn: (id: string) => api.post<{ revoked: number }>(`/staff/${id}/revoke-sessions`),
    onSuccess: invalidate,
  });

  // ── remove staff ──
  const removeStaff = useMutation({
    mutationFn: (id: string) => api.del(`/staff/${id}`),
    onSuccess: invalidate,
  });

  const canManage = store?.role === 'owner' || store?.role === 'manager';

  if (staffQ.isLoading) return <Loading />;

  const staff = staffQ.data?.items ?? [];
  const invites = invitesQ.data?.items ?? [];
  const pendingInvites = invites.filter((i) => !i.acceptedAt && new Date(i.expiresAt).getTime() > Date.now());

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="Manage team members and per-action permissions for this store."
      />

      {/* ── staff list ── */}
      <div className="card overflow-hidden mb-5">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Team members</h2>
          <span className="text-xs text-gray-400">{staff.length} member{staff.length !== 1 ? 's' : ''}</span>
        </div>

        {staffQ.error && (
          <div className="p-4">
            <ErrorNote message={(staffQ.error as Error).message} />
          </div>
        )}

        {staff.length === 0 && !staffQ.error ? (
          <EmptyState title="No staff yet" hint="Invite a team member below." />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Member</th>
                <th className="th">Role</th>
                <th className="th">Joined</th>
                {canManage && <th className="th">Permissions</th>}
                {canManage && <th className="th text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {staff.map((m) => (
                <tr key={m.adminUserId} className="border-t border-gray-100 align-top">
                  <td className="td">
                    <span className="font-medium text-sm">{m.email}</span>
                    {m.isYou && <span className="ml-1.5 text-xs text-gray-400">(you)</span>}
                  </td>
                  <td className="td">
                    {canManage && !m.isYou ? (
                      <select
                        className="input py-1 text-xs w-32"
                        value={m.role}
                        disabled={changeRole.isPending}
                        onChange={(e) => changeRole.mutate({ id: m.adminUserId, role: e.target.value as Role })}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                    ) : (
                      <Badge value={m.role} />
                    )}
                  </td>
                  <td className="td text-sm text-gray-500">{fmtDate(m.createdAt)}</td>
                  {canManage && (
                    <td className="td">
                      <PermissionsMatrix
                        member={m}
                        onSave={invalidate}
                      />
                    </td>
                  )}
                  {canManage && (
                    <td className="td text-right">
                      {!m.isYou && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            className="btn-ghost py-1 px-2 text-xs flex items-center gap-1"
                            title="Force-logout (revoke all sessions)"
                            disabled={revokeSessions.isPending}
                            onClick={() => revokeSessions.mutate(m.adminUserId)}
                          >
                            <RefreshCw size={12} />
                            Revoke sessions
                          </button>
                          <button
                            className="btn-ghost py-1 px-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-1"
                            title="Remove from store"
                            disabled={removeStaff.isPending}
                            onClick={() => {
                              if (confirm(`Remove ${m.email} from this store?`)) {
                                removeStaff.mutate(m.adminUserId);
                              }
                            }}
                          >
                            <UserMinus size={12} />
                            Remove
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {(changeRole.error || revokeSessions.error || removeStaff.error) && (
          <div className="p-4">
            <ErrorNote message={((changeRole.error || revokeSessions.error || removeStaff.error) as Error).message} />
          </div>
        )}
      </div>

      {/* ── invite staff ── */}
      {canManage && (
        <div className="card p-5 mb-5">
          <h2 className="text-sm font-semibold mb-3">Invite a team member</h2>
          <p className="text-xs text-gray-500 mb-4">
            An invite link is generated immediately. Share it with the invitee — it expires in 7 days
            and can only be accepted once.
          </p>

          {inviteResult ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                Invite created. Share the token below with the invitee — they'll set their own password on acceptance.
              </div>
              <div>
                <label className="label">Accept URL</label>
                <div className="flex items-center gap-2">
                  <input
                    className="input font-mono text-xs flex-1"
                    readOnly
                    value={`${window.location.origin}${inviteResult.acceptUrl}`}
                  />
                  <CopyButton text={`${window.location.origin}${inviteResult.acceptUrl}`} />
                </div>
              </div>
              <div>
                <label className="label">Raw token (one-time)</label>
                <div className="flex items-center gap-2">
                  <input className="input font-mono text-xs flex-1" readOnly value={inviteResult.token} />
                  <CopyButton text={inviteResult.token} />
                </div>
              </div>
              <button className="btn-ghost text-xs" onClick={() => setInviteResult(null)}>Done</button>
            </div>
          ) : inviteForm ? (
            <form
              className="space-y-3"
              onSubmit={(e) => { e.preventDefault(); sendInvite.mutate(); }}
            >
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[200px]">
                  <label className="label">Email</label>
                  <input
                    className="input"
                    type="email"
                    required
                    placeholder="team@example.com"
                    value={inviteForm.email}
                    onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Role</label>
                  <select
                    className="input w-36"
                    value={inviteForm.role}
                    onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value as Role })}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </div>
              </div>
              {/* Permission preview — show what this role can do before the invite is created. */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                <span className="font-medium">{ROLE_LABELS[inviteForm.role]}:</span> {ROLE_DESC[inviteForm.role]}
              </div>
              {sendInvite.error && <ErrorNote message={(sendInvite.error as Error).message} />}
              <div className="flex gap-2">
                <button className="btn-primary" type="submit" disabled={sendInvite.isPending}>
                  {sendInvite.isPending ? <Spinner className="text-white" /> : 'Send invite'}
                </button>
                <button className="btn-ghost" type="button" onClick={() => setInviteForm(null)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button
              className="btn-ghost"
              onClick={() => setInviteForm({ email: '', role: 'staff' })}
            >
              + New invite
            </button>
          )}
        </div>
      )}

      {/* ── pending invites ── */}
      {canManage && (
        <div className="card overflow-hidden mb-5">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Pending invites</h2>
            {invitesQ.isLoading && <Spinner />}
          </div>

          {invitesQ.error && (
            <div className="p-4">
              <ErrorNote message={(invitesQ.error as Error).message} />
            </div>
          )}

          {!invitesQ.isLoading && pendingInvites.length === 0 ? (
            <EmptyState title="No pending invites" hint="Accepted and expired invites are not shown." />
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Email</th>
                  <th className="th">Role</th>
                  <th className="th">Expires</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {pendingInvites.map((inv) => {
                  const expired = new Date(inv.expiresAt).getTime() < Date.now();
                  const accepted = !!inv.acceptedAt;
                  return (
                    <tr key={inv.id} className="border-t border-gray-100">
                      <td className="td text-sm">{inv.email}</td>
                      <td className="td"><Badge value={inv.role} /></td>
                      <td className="td text-sm text-gray-500">{fmtDate(inv.expiresAt)}</td>
                      <td className="td">
                        <Badge value={accepted ? 'active' : expired ? 'draft' : 'active'} />
                        <span className="ml-1 text-xs text-gray-400">
                          {accepted ? 'accepted' : expired ? 'expired' : 'pending'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── permission key reference (secondary — collapsed by default) ── */}
      <details className="card p-5 group">
        <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold list-none">
          Permission key reference
          <span className="text-xs font-normal text-gray-400 group-open:hidden">Show</span>
          <span className="text-xs font-normal text-gray-400 hidden group-open:inline">Hide</span>
        </summary>
        <p className="text-xs text-gray-500 mt-3 mb-3">
          Owners and managers always have all permissions. The checkboxes above grant a{' '}
          <span className="font-medium">staff</span> or{' '}
          <span className="font-medium">read_only</span> member a specific capability without
          elevating their role.
        </p>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Key</th>
              <th className="th">Label</th>
              <th className="th">What it unlocks</th>
              <th className="th">Owner</th>
              <th className="th">Manager</th>
              <th className="th">Staff</th>
              <th className="th">Read-only</th>
            </tr>
          </thead>
          <tbody>
            {PERMISSION_ACTIONS.map(({ key, label, hint }) => (
              <tr key={key} className="border-t border-gray-100 text-sm">
                <td className="td font-mono text-xs text-gray-700">{key}</td>
                <td className="td font-medium">{label}</td>
                <td className="td text-gray-500">{hint}</td>
                <td className="td text-center text-emerald-600">✓</td>
                <td className="td text-center text-emerald-600">✓</td>
                <td className="td text-center text-gray-400">per-grant</td>
                <td className="td text-center text-gray-400">per-grant</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}
