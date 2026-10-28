import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export type MenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean } | 'sep';

/** Small popover menu (.menu): Escape / outside click closes, arrow keys move, focus returns to the trigger. */
export function RowMenu({ label, items, style, icon }: { label: string; items: MenuItem[]; style?: React.CSSProperties; icon?: ReactNode }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (refocus = true) => { setPos(null); if (refocus) btn.current?.focus(); };

  useEffect(() => {
    if (!pos) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const down = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setPos(null); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const bs = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (!bs.length) return;
      e.preventDefault();
      const i = bs.indexOf(document.activeElement as HTMLButtonElement);
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]!.focus();
    };
    const away = () => setPos(null);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); window.removeEventListener('scroll', away, true); window.removeEventListener('resize', away); };
  }, [pos]);

  return (
    <>
      <button ref={btn} type="button" className="iconbtn" style={style} aria-label={label} aria-haspopup="menu" aria-expanded={!!pos}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setPos(pos ? null : { top: r.bottom + 4, right: window.innerWidth - r.right }); }}>
        {icon ?? <MoreHorizontal size={14} aria-hidden="true" />}
      </button>
      {pos && (
        <div ref={menu} className="menu" role="menu" style={{ top: pos.top, right: pos.right }}>
          {items.map((it, i) => it === 'sep' ? <hr key={i} /> : (
            <button key={i} type="button" role="menuitem" className={it.danger ? 'dng' : undefined} disabled={it.disabled} onClick={() => { close(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </>
  );
}
