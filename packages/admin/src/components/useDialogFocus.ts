import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Focus management shared by dialog shells (same behaviour as ConfirmDialog): on open, focus moves inside; Tab and
 * Shift+Tab wrap; Escape calls `onEscape` unless `busy`; on close, focus returns to the element that had it.
 * Initial focus: `[data-autofocus]`, else the first control that is not the dialog's close button, else the dialog.
 */
export function useDialogFocus(open: boolean, dialogRef: RefObject<HTMLElement | null>, onEscape: () => void, busy = false) {
  const escRef = useRef(onEscape);
  const busyRef = useRef(busy);
  escRef.current = onEscape;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !el.closest('[aria-hidden="true"]'));
    const first = dialog?.querySelector<HTMLElement>('[data-autofocus]')
      ?? controls().find((el) => el.getAttribute('data-dialog-close') == null) ?? controls()[0] ?? dialog;
    first?.focus();
    const onFocusIn = (e: FocusEvent) => {
      if (dialog && !dialog.contains(e.target as Node)) (controls()[0] ?? dialog).focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (!busyRef.current) escRef.current(); return; }
      if (e.key !== 'Tab' || !dialog) return;
      const list = controls();
      if (list.length === 0) { e.preventDefault(); dialog.focus(); return; }
      const active = document.activeElement;
      if (e.shiftKey && (active === list[0] || !dialog.contains(active))) { e.preventDefault(); list[list.length - 1]!.focus(); }
      else if (!e.shiftKey && (active === list[list.length - 1] || !dialog.contains(active))) { e.preventDefault(); list[0]!.focus(); }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, dialogRef]);
}
