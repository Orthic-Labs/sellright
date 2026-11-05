import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Plus, Trash2, UserRound } from 'lucide-react';
import { ApiError, hub, hubApi, type HubAccount, type HubTarget } from '../api';
import { adminHref } from '../lib/base-path';
import { EmptyState, ErrorNote, InlineAlert, Loading, PageHeader, Spinner } from '../components/ui';

const ERRORS: Record<string, string> = {
  reauth: 'That saved account was signed out on its server. Add it again to keep using it.',
  unknown_state: 'That sign-in had already been used or took too long. Try again.',
  issuer_mismatch: 'The server that answered wasn’t the one we asked. Nothing was saved.',
  redeem_failed: 'The other server didn’t confirm the sign-in. Try again.',
  no_session: 'This browser’s saved-accounts session ended. Try again.',
  unknown_target: 'That server isn’t configured here.',
  bad_request: 'The sign-in came back incomplete. Try again.',
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');

/**
 * #355 phase 3, hub side: accounts on other SellRight servers saved in this browser. Each one signs in on its own
 * server (password, second factor, passkeys there); this admin keeps that session sealed and relays admin calls for it.
 */
export default function SavedAccounts() {
  const qc = useQueryClient();
  const q = new URLSearchParams(location.search);
  const [notice] = useState(() => ({ enrolled: q.get('enrolled'), error: q.get('error') }));
  const data = useQuery({ queryKey: ['hub-accounts'], queryFn: () => hubApi.load(), retry: false });
  const add = useMutation({ mutationFn: (targetId: string) => hubApi.enrol(targetId), onSuccess: (to) => location.assign(to) });
  const remove = useMutation({
    mutationFn: (id: string) => hubApi.remove(id),
    onSuccess: (_r, id) => { if (hub.slot === id) hub.slot = null; void qc.invalidateQueries({ queryKey: ['hub-accounts'] }); },
  });

  function switchTo(a: HubAccount | null) {
    hub.slot = a?.id ?? null;
    location.assign(adminHref('/'));
  }

  const disabled = data.error instanceof ApiError && data.error.code === 'FEATURE_DISABLED';
  const active = hub.slot;
  return (
    <div className="max-w-4xl">
      <PageHeader title="Saved accounts" subtitle="Work in other SellRight admins from here. Each account signs in on its own server; you can remove it at any time." />
      {notice.enrolled && <div className="mb-4"><InlineAlert tone="positive" title="Account saved">It’s in the list below. Use “Switch” to work as it.</InlineAlert></div>}
      {notice.error && <div className="mb-4"><InlineAlert tone="critical" title="Not saved">{ERRORS[notice.error] ?? 'That didn’t work. Try again.'}</InlineAlert></div>}
      {active && (
        <div className="mb-4"><InlineAlert tone="info" title="You’re working as a saved account">
          <button className="btn-ghost btn-sm mt-1" onClick={() => switchTo(null)}><ArrowLeftRight size={13} /> Back to your own sign-in</button>
        </InlineAlert></div>
      )}
      {data.isLoading && <Loading label="Loading saved accounts" />}
      {disabled && <EmptyState title="Saved accounts aren’t turned on" hint="This admin isn’t set up to keep accounts for other servers." />}
      {data.error && !disabled && <ErrorNote message={(data.error as Error).message} />}
      {data.data && (
        <>
          <div className="card overflow-hidden mb-5">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2"><UserRound size={15} /> Accounts in this browser</h2>
            </div>
            {data.data.accounts.length === 0
              ? <div className="p-4"><EmptyState title="No saved accounts yet" hint="Add one below: you’ll sign in on that server, then come back here." /></div>
              : (
                <table className="w-full">
                  <thead><tr><th className="th">Account</th><th className="th">Server</th><th className="th">Last used</th><th className="th" /></tr></thead>
                  <tbody>
                    {data.data.accounts.map((a) => (
                      <tr key={a.id}>
                        <td className="td font-medium">{a.adminEmail}{active === a.id && <span className="ml-2 text-xs text-gray-500">(active)</span>}</td>
                        <td className="td text-xs">{a.targetLabel}</td>
                        <td className="td text-xs">{fmt(a.lastUsedAt)}</td>
                        <td className="td text-right whitespace-nowrap">
                          <button className="btn-ghost btn-sm" disabled={active === a.id} onClick={() => switchTo(a)}><ArrowLeftRight size={13} /> Switch</button>
                          <button className="btn-ghost btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(a.id)} title="Forget it here and sign it out on its server"><Trash2 size={13} /> Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
          <div className="card p-4">
            <h2 className="text-sm font-semibold mb-3">Add an account</h2>
            <div className="flex flex-wrap gap-2">
              {data.data.targets.map((t: HubTarget) => (
                <button key={t.id} className="btn-primary btn-sm" disabled={add.isPending} onClick={() => add.mutate(t.id)}>
                  {add.isPending && add.variables === t.id ? <Spinner className="text-white" /> : <Plus size={14} />} {t.label}
                </button>
              ))}
            </div>
            {(add.error || remove.error) && <div className="mt-3"><ErrorNote message={((add.error ?? remove.error) as Error).message} /></div>}
          </div>
        </>
      )}
    </div>
  );
}
