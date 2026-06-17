import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

/**
 * Global toast / notification system.
 *
 * Mount `<ToastProvider>` near the root of the admin app (wrapping the
 * router). Anywhere in the tree, call `useToast()` and `toast.success(...)`,
 * `toast.error(...)`, or `toast.info(...)`.
 *
 * Contract:
 *   - success + info auto-dismiss after 4s; error stays until dismissed.
 *   - role="status" for success/info (polite), role="alert" for error
 *     (assertive) — screen readers announce errors immediately.
 *   - desktop top-right stack, mobile bottom stack (single column on small
 *     screens because the right edge is often off-screen in landscape
 *     phones held two-handed).
 *   - the action button is optional — used for "Undo", "Retry", "View".
 *   - the renderer dedupes by id; use `toast.dismiss(id)` to remove early.
 */

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastAction { label: string; onClick: () => void }
export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  message?: string;
  action?: ToastAction;
}
export interface ToastInput {
  tone?: ToastTone;
  title: string;
  message?: string;
  /** ms — 0 disables auto-dismiss. Default: 4000 for success/info, 0 for error. */
  ttl?: number;
  action?: ToastAction;
}

interface ToastContext {
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  success: (title: string, message?: string) => string;
  error: (title: string, message?: string) => string;
  info: (title: string, message?: string) => string;
  /** Log a non-toast UI event (palette open/close, search, command run).
   *  Pages don't read this directly — it's available for the in-app activity
   *  widget and tests. Always returns void. */
  recordEvent: (type: ToastEvent['type'], detail?: string) => void;
  events: ToastEvent[];
}

export interface ToastEvent {
  type: 'palette-opened' | 'palette-closed' | 'palette-command' | 'palette-search' | 'palette-no-result' | 'toast-pushed';
  at: number;
  detail?: string;
}

const Ctx = createContext<ToastContext | null>(null);

const TONE_STYLE: Record<ToastTone, { wrap: string; icon: typeof Info; iconCls: string }> = {
  success: { wrap: 'bg-white border-emerald-200 text-emerald-900', icon: CheckCircle2, iconCls: 'text-emerald-500' },
  error: { wrap: 'bg-white border-red-200 text-red-900', icon: AlertCircle, iconCls: 'text-red-500' },
  info: { wrap: 'bg-white border-blue-200 text-blue-900', icon: Info, iconCls: 'text-blue-500' },
};

const DEFAULT_TTL: Record<ToastTone, number> = { success: 4000, info: 4000, error: 0 };

let _seq = 0;
function nextId() { _seq += 1; return `t${Date.now().toString(36)}${_seq.toString(36)}`; }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [events, setEvents] = useState<ToastEvent[]>([]);
  // Keep the latest events in a ref so tests can read it without subscribing to
  // a state update that would itself trigger a re-render inside push().
  const eventsRef = useRef<ToastEvent[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
  }, []);

  const push = useCallback((input: ToastInput): string => {
    const tone = input.tone ?? 'info';
    const id = nextId();
    const toast: Toast = { id, tone, title: input.title, message: input.message, action: input.action };
    setToasts((cur) => [...cur, toast]);
    const evt: ToastEvent = { type: 'toast-pushed', at: Date.now(), detail: `${tone}:${input.title}` };
    setEvents((cur) => [...cur.slice(-19), evt]);
    eventsRef.current = [...eventsRef.current.slice(-19), evt];
    const ttl = input.ttl ?? DEFAULT_TTL[tone];
    if (ttl > 0) {
      const timer = setTimeout(() => dismiss(id), ttl);
      timersRef.current.set(id, timer);
    }
    return id;
  }, [dismiss]);

  const recordEvent = useCallback((type: ToastEvent['type'], detail?: string) => {
    const evt: ToastEvent = { type, at: Date.now(), detail };
    setEvents((cur) => [...cur.slice(-19), evt]);
    eventsRef.current = [...eventsRef.current.slice(-19), evt];
  }, []);

  const success = useCallback((title: string, message?: string) => push({ tone: 'success', title, message }), [push]);
  const error = useCallback((title: string, message?: string) => push({ tone: 'error', title, message }), [push]);
  const info = useCallback((title: string, message?: string) => push({ tone: 'info', title, message }), [push]);

  // Clean up timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  useEffect(() => {
    setToastBus({ success, error, info });
    return () => setToastBus(null);
  }, [success, error, info]);

  const ctx = useMemo<ToastContext>(() => ({ push, dismiss, success, error, info, events, recordEvent }),
    [push, dismiss, success, error, info, events, recordEvent]);

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </Ctx.Provider>
  );
}

/** Public surface for components outside the React tree — non-React callers
 *  (e.g. fetch error handlers) push through this. The component below mounts
 *  it on first render via `useToast().registerBus(...)`. */
export interface ToastBus { success: ToastContext['success']; error: ToastContext['error']; info: ToastContext['info'] }
let _bus: ToastBus | null = null;
export function setToastBus(b: ToastBus | null) { _bus = b; }
export function toastBus(): ToastBus | null { return _bus; }

function ToastViewport({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    <>
      {/* Desktop: top-right stack */}
      <div className="hidden md:flex fixed top-3 right-3 z-50 flex-col gap-2 w-80 pointer-events-none" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />)}
      </div>
      {/* Mobile: bottom stack (safe-area aware) */}
      <div className="md:hidden fixed inset-x-0 bottom-0 z-50 flex flex-col gap-2 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pointer-events-none" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />)}
      </div>
    </>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { wrap, icon: Icon, iconCls } = TONE_STYLE[toast.tone];
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto rounded-lg border shadow-md ${wrap} p-3 flex items-start gap-2.5 animate-fade-in`}
    >
      <Icon size={18} className={`shrink-0 mt-0.5 ${iconCls}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{toast.title}</div>
        {toast.message && <div className="text-xs text-gray-600 mt-0.5 break-words">{toast.message}</div>}
        {toast.action && (
          <button
            className="text-xs font-medium text-brand hover:underline mt-1.5"
            onClick={() => { toast.action!.onClick(); onDismiss(); }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button onClick={onDismiss} aria-label="Dismiss notification" className="text-gray-400 hover:text-gray-600 -mr-1 -mt-1 p-1 shrink-0">
        <X size={15} />
      </button>
    </div>
  );
}

export function useToast(): ToastContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast must be used inside <ToastProvider>');
  return c;
}
