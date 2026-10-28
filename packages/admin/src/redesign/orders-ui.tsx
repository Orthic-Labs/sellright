/** #406 orders list: small shared UI bits (popover, pills, filter chip). */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X, Plus } from 'lucide-react';
import type { Pill } from './orders-helpers';

export const PillView = ({ pill }: { pill: Pill }) => <span className={`pill ${pill.tone}`}>{pill.label}</span>;

/** Button + popover that closes on outside click and Escape (Escape does not bubble to the page). */
export function Popover({ trigger, children, align = 'left' }: {
  trigger: (p: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}
      onKeyDown={(e) => { if (open && e.key === 'Escape') { e.stopPropagation(); setOpen(false); (ref.current?.querySelector('button') as HTMLElement | null)?.focus(); } }}>
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open && (
        <div id={id} className="menu" style={{ position: 'absolute', top: 'calc(100% + 4px)', [align]: 0, zIndex: 50 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}

/** Dashed "add filter" chip; becomes a set chip with a remove button once it has a value. */
export function FilterChip({ label, valueLabel, onClear, children }: {
  label: string; valueLabel: string | null; onClear: () => void; children: (close: () => void) => ReactNode;
}) {
  return (
    <Popover trigger={({ open, toggle, id }) => valueLabel ? (
      <span style={{ display: 'inline-flex', gap: 2 }}>
        <button className="chip set" aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>{label} is {valueLabel}</button>
        <button className="chip set" aria-label={`Remove filter: ${label.toLowerCase()} is ${valueLabel}`} onClick={onClear}><X size={12} aria-hidden="true" /></button>
      </span>
    ) : (
      <button className="chip" aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}><Plus size={12} aria-hidden="true" />{label}</button>
    )}>
      {children}
    </Popover>
  );
}
