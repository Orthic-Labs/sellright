// Provider for the affiliate self-serve dashboard. Thin re-export over the
// typed `~/sellright/content` wrapper (GET /v1/shop/affiliate?t=<token>,
// packages/api src/routes/admin-affiliate.ts) — kept as its own module so
// `routes/affiliate/index.tsx` doesn't need to know the request lives in
// `~/sellright`.
export { fetchAffiliateStats as fetchAffiliateStatsByToken } from '~/sellright/content';
export type { AffiliateStatsResult } from '~/sellright/types/content';
