import type { ReactNode } from 'react';

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-gray-400 py-16 justify-center text-sm">
      <Spinner /> {label}…
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between mb-5 gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

const STATE_STYLES: Record<string, string> = {
  Paid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  PendingPayment: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  Cancelled: 'bg-gray-100 text-gray-600 ring-gray-500/20',
  Refunded: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  PartiallyRefunded: 'bg-rose-50 text-rose-600 ring-rose-600/20',
  Shipped: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  Delivered: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  Pending: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  draft: 'bg-gray-100 text-gray-600 ring-gray-500/20',
};

const LABELS: Record<string, string> = { PendingPayment: 'Pending', PartiallyRefunded: 'Part. refunded' };

export function Badge({ value }: { value: string }) {
  const cls = STATE_STYLES[value] ?? 'bg-gray-100 text-gray-600 ring-gray-500/20';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>
      {LABELS[value] ?? value}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="text-center py-16">
      <p className="text-sm font-medium text-gray-600">{title}</p>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="card p-4 text-sm text-red-700 bg-red-50 border-red-200">{message}</div>;
}
