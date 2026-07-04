import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { ErrorNote, Spinner } from '../components/ui';

export type Role = 'owner' | 'manager' | 'staff' | 'read_only';
export const ROLES: Role[] = ['owner', 'manager', 'staff', 'read_only'];
export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', manager: 'Manager', staff: 'Staff', read_only: 'Read-only' };
export const ROLE_DESC: Record<Role, string> = {
  owner: 'Full access, including billing, staff, and store deletion.',
  manager: 'Manage products, orders, customers, settings, and staff. No billing.',
  staff: 'Day-to-day operations. Extra capabilities granted per-action below.',
  read_only: 'View-only access. Cannot make changes.',
};

export const PERMISSION_ACTIONS: { key: string; label: string; hint: string }[] = [
  { key: 'giftcards', label: 'Gift cards', hint: 'Create and manage gift card codes' },
  { key: 'webhooks', label: 'Webhooks', hint: 'Create, update and delete webhook endpoints' },
  { key: 'refunds', label: 'Refunds', hint: 'Refund orders and approve return requests' },
  { key: 'cancel_orders', label: 'Cancel orders', hint: 'Cancel orders and release reserved stock' },
  { key: 'releases', label: 'App releases', hint: 'Create and publish app release manifests' },
];

const UI_PERMISSION_KEYS = PERMISSION_ACTIONS.map((p) => p.key);
const isUiPermissionKey = (k: string): k is typeof UI_PERMISSION_KEYS[number] =>
  (UI_PERMISSION_KEYS as readonly string[]).includes(k);

export interface StaffMember {
  adminUserId: string;
  email: string;
  role: Role;
  createdAt: string;
  isYou: boolean;
  permissions?: Record<string, boolean> | null;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  acceptedAt: string | null;
  expiresAt: string;
}

export function isPrivileged(role: Role) {
  return role === 'owner' || role === 'manager';
}

export function PermissionsMatrix({ member, onSave }: { member: StaffMember; onSave: () => void }) {
  const existing = member.permissions ?? {};
  const [perms, setPerms] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const k of UI_PERMISSION_KEYS) init[k] = !!existing[k];
    return init;
  });
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
