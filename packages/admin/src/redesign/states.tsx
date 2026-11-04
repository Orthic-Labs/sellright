/**
 * #406 shared page states, one look across every rebuilt screen (mockup "States" sheet).
 * Copy is supplied by the caller; these components only frame it.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, Search, UserRound, Lock, Inbox } from 'lucide-react';

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ico">{icon ?? <Inbox size={18} aria-hidden="true" />}</div>
      <b>{title}</b>
      {children && <span className="muted" style={{ maxWidth: 360 }}>{children}</span>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

/** Filters matched nothing: say which filters, offer to clear them. */
export function FilteredEmpty({ what, filters, onClear }: { what: string; filters: string[]; onClear: () => void }) {
  return (
    <EmptyState title={`No ${what} match these filters`} icon={<Search size={18} aria-hidden="true" />}
      action={<button className="btn" onClick={onClear}>Clear filters</button>}>
      {filters.join(' · ')}
    </EmptyState>
  );
}

/** Skeleton rows; `label` is announced instead of the shimmer. */
export function LoadingRows({ label, rows = 6, cols = [70, 90, 0, 50] }: { label: string; rows?: number; cols?: number[] }) {
  return (
    <div className="cb-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'flex', gap: 16 }}>
          {cols.map((w, c) => <div key={c} className="sk" style={w ? { width: w } : { flex: 1 }} />)}
        </div>
      ))}
    </div>
  );
}

/** Load failed; whatever the person had set up (filters, edits) is kept. */
/** Server messages often lack a final full stop. */
export const sentence = (s: string): string => s.trim().replace(/([^.!?])$/, '$1.');

export function LoadError({ what, detail, onRetry }: { what: string; detail?: string; onRetry: () => void }) {
  return (
    <div className="banner" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <div><b>Couldn't load {what}.</b> {detail ? sentence(detail) : 'Check your connection and try again.'}</div>
      <span className="sp" />
      <button className="btn sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

/** Save failed; the edits stay in the form and the save bar stays up. */
export function SaveFailed({ count, detail, onRetry, busy }: { count: number; detail: string; onRetry: () => void; busy?: boolean }) {
  return (
    <div className="banner" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <div><b>Couldn't save {count} change{count === 1 ? '' : 's'}.</b> {detail} Your edits are still here.</div>
      <span className="sp" />
      <button className="btn sm" onClick={onRetry} disabled={busy}>Try again</button>
    </div>
  );
}

/** Someone else saved first. Nothing is saved until the person chooses. */
export function ConflictBanner({ children, onTheirs, onMine, busy }: { children: ReactNode; onTheirs: () => void; onMine: () => void; busy?: boolean }) {
  return (
    <div className="banner w" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <div>{children} Nothing is saved until you choose.</div>
      <span className="sp" />
      <button className="btn sm" onClick={onTheirs} disabled={busy}>Use theirs</button>
      <button className="btn sm" onClick={onMine} disabled={busy}>Keep mine</button>
    </div>
  );
}

export function SessionExpired({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="banner i" role="alert">
      <UserRound size={16} aria-hidden="true" />
      <div><b>You were signed out.</b> Sign in again to save. Unsaved edits stay in this tab.</div>
      <span className="sp" />
      <button className="btn sm pri" onClick={onSignIn}>Sign in</button>
    </div>
  );
}

export function NoPermission({ area, role }: { area: string; role?: string }) {
  return (
    <EmptyState title={`${area} needs more access`} icon={<Lock size={18} aria-hidden="true" />}>
      {role ? `Your role (${role}) can't open ${area.toLowerCase()}.` : `Your role can't open ${area.toLowerCase()}.`} Ask the store owner for access.
    </EmptyState>
  );
}
