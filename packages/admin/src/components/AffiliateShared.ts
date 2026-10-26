import type { BadgeTone } from './ui';

export type AffiliateStatus = 'Active' | 'Disabled' | 'Deleted';

/** Coupon status chip colours (DD AffiliateListPage STATUS_DOT: green / grey / red). */
export const AFFILIATE_STATUS_TONE: Record<AffiliateStatus, BadgeTone> = { Active: 'positive', Disabled: 'neutral', Deleted: 'critical' };

/** Self-serve dashboard link. The token rides in the URL fragment (#t=) so it
 *  never reaches server logs or Referer headers — same form the welcome mail uses. */
export const affiliateDashboardLink = (origin: string, token: string) => `${origin}/affiliate#t=${token}`;

export interface Aff {
  id: string; email: string; code: string | null; status: AffiliateStatus;
  earned: number; settled: number; unsettled: number; orders: number; lastSettledAt: string | null;
}

export type AffSortKey = 'email' | 'code' | 'status' | 'orders' | 'earned' | 'settled' | 'unsettled' | 'lastSettledAt';

/** Search (email / code), "Active only" vs all statuses, then sort — DD AffiliateListPage.tsx. Nulls always sort last. */
export function filterAndSort(rows: Aff[], opts: { search: string; activeOnly: boolean; key: AffSortKey; dir: 'asc' | 'desc' }): Aff[] {
  const q = opts.search.trim().toLowerCase();
  return rows
    .filter((r) => !opts.activeOnly || r.status === 'Active')
    .filter((r) => !q || r.email.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q))
    .sort((a, b) => {
      const va = a[opts.key]; const vb = b[opts.key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return opts.dir === 'asc' ? cmp : -cmp;
    });
}

