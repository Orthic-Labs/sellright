/**
 * #406 modal shell shared by the Payments and Discounts rebuilds: a native <dialog> in the `.rd` scope.
 * Content mounts only while open, so every open starts from a clean state.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dlg({ open, title, onClose, children, footer, sub }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; sub?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dlg" aria-labelledby={id} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {open && (
        <>
          <div className="dh">
            <h2 id={id}>{title}</h2>
            {sub && <span className="muted" style={{ fontSize: 12 }}>{sub}</span>}
            <span className="sp" />
            <button className="iconbtn" onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button>
          </div>
          <div className="db">{children}</div>
          {footer && <div className="df">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

/** Confirmation that spells out the consequence. `danger` styles the confirm button as destructive. */
export function ConfirmDlg({ open, title, children, confirmLabel, danger, busy, onConfirm, onClose }: {
  open: boolean; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dlg open={open} title={title} onClose={onClose} footer={
      <>
        <span className="sp" />
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? 'dngf' : 'pri'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
      </>
    }>
      {children}
    </Dlg>
  );
}
