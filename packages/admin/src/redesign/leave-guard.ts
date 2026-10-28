/**
 * #406 unsaved-changes guard. Editors register while they hold unsaved edits; every way out of the page asks
 * first: in-app links (captured below), the store switcher and the command palette (confirmLeave), and
 * reload/close (beforeunload). BrowserRouter has no blocker API, so links are intercepted at the document.
 */
import { useEffect } from 'react';

type Guard = { message: string };
const guards = new Set<Guard>();
let navigateRef: ((to: string) => void) | null = null;

export function isDirty(): boolean { return guards.size > 0; }

/** Resolves true when nothing is unsaved or the person chose to discard. */
export function confirmLeave(): Promise<boolean> {
  const g = [...guards][0];
  if (!g) return Promise.resolve(true);
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    dlg.setAttribute('aria-labelledby', 'leave-title');
    const wrap = document.createElement('div');
    wrap.className = 'rd';
    wrap.appendChild(dlg);
    dlg.innerHTML = `<div class="dh"><h2 id="leave-title">Discard unsaved changes?</h2></div>
      <div class="db"><p></p></div>
      <div class="df"><span class="sp"></span><button class="btn" data-k="stay">Keep editing</button><button class="btn dngf" data-k="leave">Discard and leave</button></div>`;
    dlg.querySelector('p')!.textContent = g.message;
    const back = document.activeElement as HTMLElement | null;
    const done = (ok: boolean) => { dlg.close(); wrap.remove(); back?.focus?.(); resolve(ok); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    dlg.querySelector('[data-k=stay]')!.addEventListener('click', () => done(false));
    dlg.querySelector('[data-k=leave]')!.addEventListener('click', () => { guards.clear(); done(true); });
    document.body.appendChild(wrap);
    dlg.showModal();
    (dlg.querySelector('[data-k=stay]') as HTMLElement).focus();
  });
}

/** Register while `dirty` is true. */
export function useLeaveGuard(dirty: boolean, message = 'Your changes on this page have not been saved.') {
  useEffect(() => {
    if (!dirty) return;
    const g = { message };
    guards.add(g);
    return () => { guards.delete(g); };
  }, [dirty, message]);
}

/** Mounted once by Layout: link interception + reload guard. */
export function useLeaveGuardRoot(navigate: (to: string) => void) {
  useEffect(() => {
    navigateRef = navigate;
    const onClick = (e: MouseEvent) => {
      if (!guards.size || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.origin !== location.origin) return;
      const to = a.pathname + a.search + a.hash;
      if (to === location.pathname + location.search + location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      void confirmLeave().then((ok) => { if (ok) navigateRef?.(to); });
    };
    const onUnload = (e: BeforeUnloadEvent) => { if (guards.size) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => { document.removeEventListener('click', onClick, true); window.removeEventListener('beforeunload', onUnload); navigateRef = null; };
  }, [navigate]);
}
