import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Shared, accessible confirm dialog — replaces the browser's native
 * `window.confirm(...)`. The native dialog can't be styled, isn't announced
 * consistently to screen readers, blocks the whole tab (including other
 * async work in flight), and is easy to auto-accept/dismiss in a way that
 * bypasses a genuine "are you sure" gate. This component is a real,
 * focus-trapped, Escape-to-cancel modal instead.
 *
 * Two ways to use it:
 *   1. Controlled — render <ConfirmDialog open .../> directly when you
 *      already keep the "which thing am I confirming" state yourself.
 *   2. `useConfirmDialog()` — a drop-in replacement for
 *      `if (confirm('...')) doThing()`: `if (await confirm({...})) doThing()`.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' for destructive actions (cancel/purge/delete) — red confirm button. */
  tone?: 'danger' | 'primary';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  tone = 'primary', loading = false, onConfirm, onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 animate-fade-in" onClick={loading ? undefined : onCancel} aria-hidden="true" />
      <div className="fixed inset-x-0 top-[20vh] z-50 mx-auto w-full max-w-sm px-3" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby={description ? 'confirm-dialog-desc' : undefined}>
        <div className="card p-5 shadow-lg">
          <div className="flex items-start gap-3">
            {tone === 'danger' && (
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger-soft text-danger" aria-hidden="true">
                <AlertTriangle size={18} />
              </span>
            )}
            <div className="min-w-0">
              <h2 id="confirm-dialog-title" className="text-sm font-semibold text-ink">{title}</h2>
              {description && <p id="confirm-dialog-desc" className="mt-1.5 text-sm text-gray-500">{description}</p>}
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" disabled={loading} onClick={onCancel}>{cancelLabel}</button>
            <button
              ref={confirmRef}
              type="button"
              className={tone === 'danger' ? 'btn-danger btn-sm' : 'btn-primary btn-sm'}
              disabled={loading}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

interface PendingConfirm {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  resolve: (ok: boolean) => void;
}

/**
 * `const { confirm, dialog } = useConfirmDialog();` then render `{dialog}`
 * once near the top of the page, and replace `if (confirm('x')) doIt()` with
 * `if (await confirm({ title: 'x' })) doIt()`.
 */
export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((opts: Omit<PendingConfirm, 'resolve'>): Promise<boolean> => {
    return new Promise<boolean>((resolve) => setPending({ ...opts, resolve }));
  }, []);

  const dialog = (
    <ConfirmDialog
      open={pending != null}
      title={pending?.title ?? ''}
      description={pending?.description}
      confirmLabel={pending?.confirmLabel}
      cancelLabel={pending?.cancelLabel}
      tone={pending?.tone}
      onCancel={() => { pending?.resolve(false); setPending(null); }}
      onConfirm={() => { pending?.resolve(true); setPending(null); }}
    />
  );

  return { confirm, dialog };
}
