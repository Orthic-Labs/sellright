import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  const loadingRef = useRef(loading);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const previousLoadingRef = useRef(loading);

  onCancelRef.current = onCancel;
  loadingRef.current = loading;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !el.closest('[aria-hidden="true"]'));
    const focusInside = () => {
      const controls = focusable();
      const target = controls[0] ?? dialog;
      if (target) {
        lastFocusedRef.current = target;
        target.focus();
      }
    };

    const initialFocus = confirmRef.current?.disabled ? dialog : confirmRef.current;
    if (initialFocus) {
      lastFocusedRef.current = initialFocus;
      initialFocus.focus();
    }
    const onFocusIn = (e: FocusEvent) => {
      if (!dialog) return;
      if (dialog.contains(e.target as Node)) lastFocusedRef.current = e.target as HTMLElement;
      else focusInside();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!loadingRef.current) onCancelRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const controls = focusable();
      if (controls.length === 0) {
        e.preventDefault();
        dialog.focus();
      } else if (e.shiftKey && (document.activeElement === controls[0] || !dialog.contains(document.activeElement))) {
        e.preventDefault();
        controls[controls.length - 1]!.focus();
      } else if (!e.shiftKey && (document.activeElement === controls[controls.length - 1] || !dialog.contains(document.activeElement))) {
        e.preventDefault();
        controls[0]!.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const becameLoading = loading && !previousLoadingRef.current;
    previousLoadingRef.current = loading;
    if (!becameLoading) return;
    const dialog = dialogRef.current;
    const lastFocused = lastFocusedRef.current;
    if (dialog && lastFocused && dialog.contains(lastFocused) && lastFocused.hasAttribute('disabled')) {
      dialog.focus();
      lastFocusedRef.current = dialog;
    }
  }, [open, loading]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 animate-fade-in" onClick={loading ? undefined : onCancel} aria-hidden="true" />
      <div ref={dialogRef} tabIndex={-1} className="fixed inset-x-0 top-[20vh] z-50 mx-auto w-full max-w-sm px-3" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby={description ? 'confirm-dialog-desc' : undefined}>
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
