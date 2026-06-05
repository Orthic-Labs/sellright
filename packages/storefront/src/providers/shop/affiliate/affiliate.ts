// Lightweight provider for the affiliate dashboard. Uses raw GraphQL
// because the affiliate query lives in a plugin extension and we don't
// want to touch codegen here (HardenPlugin blocks codegen in prod anyway).

const QUERY = `
    query AffiliateStatsByToken($token: String!) {
        affiliateStatsByToken(token: $token) {
            success
            error
            email
            couponCode
            rate
            totals { earnedUsd paidUsd owedUsd orderCount rangeStart rangeEnd }
            orders { redactedCode placedAt itemCount subtotalUsd commissionUsd state }
            topProducts { name sku qtySold revenueUsd }
            settles { amountUsd periodStartAt periodEndAt settledAt txRef }
        }
    }
`;

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
        const res = await fetch('http://localhost:3100/shop-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: QUERY, variables: { token } }),
        });
        const json: any = await res.json();
        if (json.errors?.length) {
            return { success: false, error: 'Server error.' };
        }
        return json.data?.affiliateStatsByToken ?? { success: false, error: 'No data.' };
    } catch (e) {
        console.error('Affiliate stats fetch failed:', e);
        return { success: false, error: 'Could not reach the dashboard service.' };
    }
}
