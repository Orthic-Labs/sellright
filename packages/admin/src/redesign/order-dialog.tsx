/**
 * #406 shared modal shell for the fulfil / refund / cancel dialogs: native <dialog> + showModal, labelled by its
 * heading, Esc closes unless busy, focus returns to the trigger on close. Children mount only while open, so
 * every open starts from fresh form state.
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { X, AlertTriangle } from 'lucide-react';

export function ModalDialog({ open, onClose, busy = false, title, subtitle, returnFocus, children }: {
  open: boolean; onClose: () => void; busy?: boolean; title: string; subtitle?: string;
  /** Element to refocus on close. Falls back to whatever had focus when the dialog opened. */
  returnFocus?: RefObject<HTMLElement | null>;
  children: (titleId: string) => ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      d.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)')?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Focus goes back after the dialog is gone, to the explicit trigger when given.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCloseEvt = () => {
      const target = returnFocus?.current?.isConnected ? returnFocus.current : opener.current?.isConnected ? opener.current : null;
      opener.current = null;
      setTimeout(() => target?.focus(), 0);
    };
    d.addEventListener('close', onCloseEvt);
    return () => d.removeEventListener('close', onCloseEvt);
  }, [returnFocus]);

  return (
    <div className="rd" style={{ display: 'contents' }}>
      <dialog
        ref={ref} className="dlg" aria-labelledby={titleId}
        onCancel={(e) => { e.preventDefault(); if (!busyRef.current) onClose(); }}
      >
        {open && (
          <>
            <div className="dh">
              <h2 id={titleId}>{title}</h2>
              {subtitle && <span className="muted" style={{ fontSize: 12 }}>{subtitle}</span>}
              <span className="sp" />
              <button type="button" className="iconbtn" aria-label="Close" onClick={onClose} disabled={busy}><X size={16} aria-hidden="true" /></button>
            </div>
            {children(titleId)}
          </>
        )}
      </dialog>
    </div>
  );
}

/** In-dialog failure: inputs stay as typed. */
export function DialogError({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="banner" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <div><b>{title}</b> {children}</div>
    </div>
  );
}
