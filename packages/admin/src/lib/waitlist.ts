/** Query-string + sort helpers for the waitlist demand report (G10). */
export type WaitlistSort = 'pending' | 'total' | 'notified' | 'canceled' | 'product' | 'variant' | 'available' | 'lastSignup' | 'oldestPending';
export type WaitlistGroup = 'variant' | 'product';
export type SortDir = 'asc' | 'desc';

export function waitlistQuery(o: { from: string; to: string; groupBy: WaitlistGroup; sort: WaitlistSort; dir: SortDir }): string {
  const p = new URLSearchParams();
  if (o.from) p.set('from', o.from);
  if (o.to) p.set('to', o.to);
  p.set('groupBy', o.groupBy);
  p.set('sort', o.sort);
  p.set('dir', o.dir);
  return p.toString();
}

/** Clicking the active column flips direction; a new column starts descending for counts/dates, ascending for names. */
export function nextSort(cur: { sort: WaitlistSort; dir: SortDir }, clicked: WaitlistSort): { sort: WaitlistSort; dir: SortDir } {
  if (cur.sort === clicked) return { sort: clicked, dir: cur.dir === 'desc' ? 'asc' : 'desc' };
  return { sort: clicked, dir: clicked === 'product' || clicked === 'variant' || clicked === 'oldestPending' ? 'asc' : 'desc' };
}
