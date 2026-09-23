// Provider for the affiliate self-serve dashboard. Rewired from a Vendure
// GraphQL query (affiliateStatsByToken, which had no SellRight REST
// equivalent) to the SellRight API's public REST route: GET
// /v1/shop/affiliate?t=<token> (packages/api src/routes/admin-affiliate.ts).
// That route is token-gated (no admin auth) and shaped to match the
// AffiliateStatsResult contract below exactly, so this provider is a thin
// fetch + reshape, same pattern as sellright-seo.ts's sitemap/robots proxy.
const API = import.meta.env.VITE_SELLRIGHT_API_URL || 'http://127.0.0.1:3300';
const STORE = import.meta.env.VITE_SELLRIGHT_STORE_SLUG || 'demo';

export interface AffiliateStatsResult {
    success: boolean;
    error?: string | null;
    email?: string | null;
    couponCode?: string | null;
    rate?: number | null;
    totals?: {
        earnedUsd: number;
        paidUsd: number;
        owedUsd: number;
        orderCount: number;
        rangeStart: string | null;
        rangeEnd: string | null;
    } | null;
    orders?: Array<{
        redactedCode: string;
        placedAt: string;
        itemCount: number;
        subtotalUsd: number;
        commissionUsd: number;
        state: string;
    }> | null;
    topProducts?: Array<{
        name: string;
        sku: string;
        qtySold: number;
        revenueUsd: number;
    }> | null;
    settles?: Array<{
        amountUsd: number;
        periodStartAt: string | null;
        periodEndAt: string;
        settledAt: string;
        txRef?: string | null;
    }> | null;
}

export async function fetchAffiliateStatsByToken(token: string): Promise<AffiliateStatsResult> {
    if (!token || token.length < 16) {
        return { success: false, error: 'Invalid or expired link.' };
    }
    try {
        const res = await fetch(`${API}/v1/shop/affiliate?t=${encodeURIComponent(token)}`, {
            headers: { 'x-store-slug': STORE, accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 404) {
            return { success: false, error: 'Invalid affiliate link.' };
        }
        if (!res.ok) {
            return { success: false, error: 'Server error.' };
        }
        const json = (await res.json()) as AffiliateStatsResult;
        return { ...json, success: true };
    } catch (e) {
        console.error('Affiliate stats fetch failed:', e);
        return { success: false, error: 'Could not reach the dashboard service.' };
    }
}
