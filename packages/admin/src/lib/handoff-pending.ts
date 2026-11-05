/** #355: a hub's handoff request waiting for this tab to sign in (pages/Handoff.tsx). Kept out of the page chunk so
 *  the sign-in screen can return to it without loading the page. */
export const PENDING_KEY = 'sr_handoff_pending';

export function pendingHandoff(): boolean {
  try { return !!sessionStorage.getItem(PENDING_KEY); } catch { return false; }
}
