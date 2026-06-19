/**
 * Runtime theme system. Themes are CSS-variable token sets in theme-tokens.css;
 * here we just flip `data-theme` + the `.dark` class on <html> and persist the
 * choice. A no-flash init script in index.html applies the stored values before
 * first paint; this hook keeps them in sync and reacts to OS dark-mode changes.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun, Palette } from 'lucide-react';

export const THEMES = [
  { id: 'vermillion', name: 'Vermillion', swatch: '#CB3D14' },
  { id: 'graphite', name: 'Graphite', swatch: '#5B5BD6' },
  { id: 'porcelain', name: 'Porcelain', swatch: '#0B5FFF' },
  { id: 'carbon', name: 'Carbon', swatch: '#B26C00' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];
export type Mode = 'light' | 'dark' | 'system';

const THEME_KEY = 'sr-theme';
const MODE_KEY = 'sr-mode';
const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

export function applyTheme(theme: ThemeId, mode: Mode) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', mode === 'dark' || (mode === 'system' && prefersDark()));
}

const storedTheme = (): ThemeId => {
  const t = localStorage.getItem(THEME_KEY) as ThemeId | null;
  return THEMES.some((x) => x.id === t) ? (t as ThemeId) : 'vermillion';
};
const storedMode = (): Mode => {
  const m = localStorage.getItem(MODE_KEY);
  return m === 'light' || m === 'dark' || m === 'system' ? m : 'system';
};

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(storedTheme);
  const [mode, setModeState] = useState<Mode>(storedMode);
  useEffect(() => { applyTheme(theme, mode); }, [theme, mode]);
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => applyTheme(theme, mode);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [theme, mode]);
  return {
    theme, mode,
    setTheme: (t: ThemeId) => { localStorage.setItem(THEME_KEY, t); setThemeState(t); },
    setMode: (m: Mode) => { localStorage.setItem(MODE_KEY, m); setModeState(m); },
  };
}

const MODES: { id: Mode; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

export function ThemeMenu() {
  const { theme, mode, setTheme, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-label="Theme" aria-haspopup="menu" aria-expanded={open}
        className="grid h-8 w-8 place-items-center rounded-lg text-gray-600 hover:bg-surface-2">
        <Palette size={17} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1.5 w-52 rounded-xl bg-surface border border-line shadow-popover p-2 z-50 animate-fade-in">
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">Theme</div>
          {THEMES.map((t) => (
            <button key={t.id} role="menuitemradio" aria-checked={theme === t.id} onClick={() => setTheme(t.id)} className="menu-item justify-between">
              <span className="flex items-center gap-2.5">
                <span className="h-3.5 w-3.5 rounded-full ring-1 ring-line-strong" style={{ background: t.swatch }} aria-hidden="true" />
                {t.name}
              </span>
              {theme === t.id && <Check size={15} className="text-accent" />}
            </button>
          ))}
          <div className="mt-1.5 pt-1.5 border-t border-line">
            <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">Appearance</div>
            <div className="flex gap-1 px-1 pb-0.5">
              {MODES.map((m) => {
                const Icon = m.icon;
                const active = mode === m.id;
                return (
                  <button key={m.id} onClick={() => setMode(m.id)} aria-pressed={active}
                    className={`flex flex-1 flex-col items-center gap-1 rounded-lg py-2 text-[11px] transition-colors ${active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2'}`}>
                    <Icon size={15} />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
