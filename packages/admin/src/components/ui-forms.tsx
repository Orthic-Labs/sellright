import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

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
