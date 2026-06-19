import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal, AlertCircle, CheckCircle2, Info, AlertTriangle, RefreshCw } from 'lucide-react';

/* ------------------------------------------------------------------ *
 * Loading + spinner
 * ------------------------------------------------------------------ */

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-gray-400 py-16 justify-center text-sm" role="status">
      <Spinner /> {label}…
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Skeletons — keep table/page height stable while data loads
 * ------------------------------------------------------------------ */

export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function SkeletonText({ w = 'w-24' }: { w?: string }) {
  return <span className={`skeleton inline-block h-3.5 ${w} rounded`} />;
}

/* ------------------------------------------------------------------ *
 * Page header
 * ------------------------------------------------------------------ */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between mb-5 gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Status badges — domain states mapped onto a semantic palette
 * ------------------------------------------------------------------ */

const POSITIVE = 'bg-success-soft text-success';
const ATTENTION = 'bg-warning-soft text-warning';
const CRITICAL = 'bg-danger-soft text-danger';
const INFO = 'bg-info-soft text-info';
const NEUTRAL = 'bg-surface-2 text-muted';

const STATE_STYLES: Record<string, string> = {
  // Payment / order
  Paid: POSITIVE, Authorized: POSITIVE, PendingPayment: ATTENTION, Pending: ATTENTION,
  Cancelled: NEUTRAL, Refunded: CRITICAL, PartiallyRefunded: CRITICAL,
  // Fulfillment
  Shipped: INFO, Delivered: POSITIVE, Fulfilled: POSITIVE, Unfulfilled: ATTENTION, PartiallyShipped: INFO,
  // Publish / generic
  active: POSITIVE, published: POSITIVE, draft: NEUTRAL, disabled: NEUTRAL, archived: NEUTRAL,
  // Connection / health
  connected: POSITIVE, connecting: ATTENTION, failed: CRITICAL, not_connected: NEUTRAL,
  // Inventory
  in_stock: POSITIVE, low_stock: ATTENTION, out_of_stock: CRITICAL,
};

const LABELS: Record<string, string> = {
  PendingPayment: 'Pending', PartiallyRefunded: 'Part. refunded', PartiallyShipped: 'Part. shipped',
  not_connected: 'Not connected', in_stock: 'In stock', low_stock: 'Low stock', out_of_stock: 'Out of stock',
};

export type BadgeTone = 'positive' | 'attention' | 'critical' | 'info' | 'neutral';
const TONE: Record<BadgeTone, string> = { positive: POSITIVE, attention: ATTENTION, critical: CRITICAL, info: INFO, neutral: NEUTRAL };

export function Badge({ value, tone, label }: { value: string; tone?: BadgeTone; label?: string }) {
  const cls = tone ? TONE[tone] : (STATE_STYLES[value] ?? NEUTRAL);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden="true" />
      {label ?? LABELS[value] ?? value}
    </span>
  );
}

// Alias — same component, clearer name at call sites that mean "status".
export const StatusBadge = Badge;

/* ------------------------------------------------------------------ *
 * Inline alerts + error states
 * ------------------------------------------------------------------ */

const ALERT: Record<BadgeTone, { wrap: string; icon: typeof Info; iconCls: string }> = {
  info: { wrap: 'bg-info-soft border-info text-info', icon: Info, iconCls: 'text-info' },
  positive: { wrap: 'bg-success-soft border-success text-success', icon: CheckCircle2, iconCls: 'text-success' },
  attention: { wrap: 'bg-warning-soft border-warning text-warning', icon: AlertTriangle, iconCls: 'text-warning' },
  critical: { wrap: 'bg-danger-soft border-danger text-danger', icon: AlertCircle, iconCls: 'text-danger' },
  neutral: { wrap: 'bg-surface-2 border-line text-ink', icon: Info, iconCls: 'text-muted' },
};

export function InlineAlert({ tone = 'info', title, children }: { tone?: BadgeTone; title?: ReactNode; children?: ReactNode }) {
  const a = ALERT[tone];
  const Icon = a.icon;
  return (
    <div className={`flex gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${a.wrap}`} role={tone === 'critical' ? 'alert' : 'status'}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${a.iconCls}`} aria-hidden="true" />
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>}
      </div>
    </div>
  );
}

// Backward-compatible: existing pages import ErrorNote.
export function ErrorNote({ message }: { message: string }) {
  return <InlineAlert tone="critical">{message}</InlineAlert>;
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="text-center py-14 px-6">
      <AlertCircle size={26} className="mx-auto text-danger" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium text-gray-700">{title}</p>
      <p className="mt-1 text-xs text-gray-500 max-w-sm mx-auto">{message}</p>
      {onRetry && (
        <button className="btn-ghost btn-sm mt-4 mx-auto" onClick={onRetry}><RefreshCw size={13} /> Try again</button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Empty states
 * ------------------------------------------------------------------ */

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="text-center py-16">
      <p className="text-sm font-medium text-gray-600">{title}</p>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

export interface EmptyAction { label: string; to?: string; onClick?: () => void; variant?: 'primary' | 'ghost'; icon?: ReactNode }

export function EmptyStateActionPanel({ icon, title, description, actions = [] }: {
  icon?: ReactNode; title: string; description?: string; actions?: EmptyAction[];
}) {
  return (
    <div className="text-center py-16 px-6">
      {icon && <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-brand-light text-brand">{icon}</div>}
      <p className="text-sm font-semibold text-gray-800">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">{description}</p>}
      {actions.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {actions.map((a) => {
            const cls = a.variant === 'ghost' ? 'btn-ghost' : 'btn-primary';
            return a.to
              ? <Link key={a.label} to={a.to} className={cls}>{a.icon}{a.label}</Link>
              : <button key={a.label} className={cls} onClick={a.onClick}>{a.icon}{a.label}</button>;
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tabs — segmented control (saved-view style)
 * ------------------------------------------------------------------ */

export interface TabDef { key: string; label: string; count?: number }

export function Tabs({ tabs, value, onChange }: { tabs: TabDef[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="flex rounded-lg border border-gray-200 bg-surface p-0.5" role="tablist">
      {tabs.map((t) => {
        const active = value === t.key;
        return (
          <button key={t.key} role="tab" aria-selected={active} onClick={() => onChange(t.key)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${active ? 'bg-brand-light text-brand font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
            {t.label}
            {t.count != null && <span className={`ml-1.5 tnum text-xs ${active ? 'text-brand/70' : 'text-gray-400'}`}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ActionMenu — overflow dropdown for grouped secondary actions
 * ------------------------------------------------------------------ */

export interface MenuItem { label: string; icon?: ReactNode; onClick?: () => void; to?: string; danger?: boolean; disabled?: boolean }

export function ActionMenu({ items, label, align = 'right' }: { items: MenuItem[]; label?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={label ? undefined : 'More actions'}
        className="btn-ghost whitespace-nowrap">
        {label ?? <MoreHorizontal size={16} />}
      </button>
      {open && (
        <div role="menu" className={`absolute z-30 mt-1.5 w-52 card p-1 animate-fade-in ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {items.map((it) => {
            const inner = <>{it.icon}<span>{it.label}</span></>;
            const cls = it.danger ? 'menu-item-danger' : 'menu-item';
            if (it.to) return <Link key={it.label} role="menuitem" to={it.to} className={cls} onClick={() => setOpen(false)}>{inner}</Link>;
            return (
              <button key={it.label} role="menuitem" disabled={it.disabled} className={`${cls} disabled:opacity-40`}
                onClick={() => { setOpen(false); it.onClick?.(); }}>{inner}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ResourceToolbar — tabs/search/filters left, actions right
 * ------------------------------------------------------------------ */

export function ResourceToolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {left}
      <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search', className = 'w-64' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input className="input pl-9" placeholder={placeholder} aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ResourceTable — generic, fixed-layout, stable table with built-in
 * loading (skeleton rows), error, and empty states.
 * ------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  header: ReactNode;
  align?: 'left' | 'center' | 'right';
  className?: string;
  width?: string;
  render: (row: T) => ReactNode;
}

const alignCls = (a?: 'left' | 'center' | 'right') => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');

export function ResourceTable<T>({
  columns, rows, rowKey, onRowClick, loading, isFetching, error, onRetry, empty, skeletonRows = 8,
  selection, toolbar,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  isFetching?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: ReactNode;
  skeletonRows?: number;
  /**
   * Optional row selection. When provided, a checkbox column is rendered and
   * `onSelectionChange` is called with the new set of selected row keys.
   * The header checkbox selects/deselects only the rows currently visible —
   * cross-page selection is intentionally NOT supported in v1 (would require
   * either an unbounded cache or a server-side operation queue).
   */
  selection?: {
    selectedKeys: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onToggleAllVisible: (keys: string[]) => void;
  };
  toolbar?: (selectedCount: number) => ReactNode;
}) {
  const allChecked = !!selection && !!rows && rows.length > 0 && rows.every((r) => selection.selectedKeys.has(rowKey(r)));
  const someChecked = !!selection && !!rows && rows.some((r) => selection.selectedKeys.has(rowKey(r)));
  const headCheckbox = selection ? (
    <input
      type="checkbox"
      aria-label="Select all visible rows"
      className="h-4 w-4 accent-brand align-middle"
      checked={allChecked}
      ref={(el) => { if (el) el.indeterminate = !allChecked && someChecked; }}
      onChange={() => selection.onToggleAllVisible(rows?.map(rowKey) ?? [])}
    />
  ) : null;

  const head = (
    <thead>
      <tr>
        {headCheckbox !== null && <th className="th" style={{ width: '2.25rem' }}>{headCheckbox}</th>}
        {columns.map((c) => (
          <th key={c.key} className={`th ${alignCls(c.align)} ${c.className ?? ''}`} style={c.width ? { width: c.width } : undefined}>{c.header}</th>
        ))}
      </tr>
    </thead>
  );

  if (error) {
    return <div className="card overflow-hidden"><ErrorState message={error} onRetry={onRetry} /></div>;
  }

  if (loading) {
    return (
      <div className="card overflow-hidden">
        <table className="w-full table-fixed">
          {head}
          <tbody>
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={i}>
                {headCheckbox !== null && <td className="td"><SkeletonBlock className="h-4 w-4" /></td>}
                {columns.map((c) => (
                  <td key={c.key} className={`td ${alignCls(c.align)}`}>
                    <SkeletonBlock className={`h-4 ${c.align === 'right' ? 'ml-auto w-12' : c.align === 'center' ? 'mx-auto w-10' : 'w-3/4'}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return <div className="card overflow-hidden">{empty ?? <EmptyState title="Nothing here yet" />}</div>;
  }

  const selectedCount = selection?.selectedKeys.size ?? 0;
  return (
    <div className="card overflow-hidden">
      {toolbar && selectedCount > 0 && (
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 bg-brand-light/40">
          <span className="text-xs font-medium text-brand">{selectedCount} selected</span>
          <div className="ml-auto flex items-center gap-2">{toolbar(selectedCount)}</div>
        </div>
      )}
      <table className="w-full table-fixed">
        {head}
        <tbody className={isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {rows.map((row) => {
            const key = rowKey(row);
            const isSelected = !!selection?.selectedKeys.has(key);
            return (
              <tr key={key} className={`${onRowClick ? 'row-link' : ''} ${isSelected ? 'bg-brand-light/40' : ''}`} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {selection && (
                  <td className="td" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select row ${key}`}
                      className="h-4 w-4 accent-brand align-middle"
                      checked={isSelected}
                      onChange={() => selection.onToggle(key)}
                    />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={`td ${alignCls(c.align)} ${c.className ?? ''}`}>{c.render(row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * KPI card — metric with optional period-over-period delta
 * ------------------------------------------------------------------ */

export function KpiCard({ label, value, delta, hint, icon, to, onClick }: {
  label: string; value: ReactNode; delta?: number | null; hint?: ReactNode; icon?: ReactNode; to?: string; onClick?: () => void;
}) {
  const interactive = !!(to || onClick);
  const body = (
    <>
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-gray-500">{label}</div>
        {icon && <span className="text-gray-300">{icon}</span>}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tnum">{value}</div>
      <div className="mt-0.5 flex items-center gap-2 text-xs">
        {delta != null && (
          <span className={`tnum font-medium ${delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-subtle'}`}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '—'} {Math.abs(delta)}%
          </span>
        )}
        {hint && <span className="text-gray-400">{hint}</span>}
      </div>
    </>
  );
  const cls = `card p-4 block text-left ${interactive ? 'hover:border-gray-300 transition-colors' : ''}`;
  if (to) return <Link to={to} className={cls}>{body}</Link>;
  if (onClick) return <button onClick={onClick} className={cls + ' w-full'}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

/* ------------------------------------------------------------------ *
 * FormSection — labelled config block with optional actions footer
 * ------------------------------------------------------------------ */

export function FormSection({ title, description, children, actions, id }: {
  title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string;
}) {
  return (
    <section id={id} className="panel">
      <div className="border-b border-gray-100 px-5 py-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
      </div>
      <div className="px-5 py-4 space-y-4">{children}</div>
      {actions && <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">{actions}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Field — labelled input wrapper with error text
 * ------------------------------------------------------------------ */

export function Field({ label, htmlFor, error, hint, children }: {
  label: string; htmlFor?: string; error?: string | null; hint?: ReactNode; children: ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

export function Pagination({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
      <span className="tnum">Page {page} of {totalPages}</span>
      <div className="flex gap-2">
        <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
