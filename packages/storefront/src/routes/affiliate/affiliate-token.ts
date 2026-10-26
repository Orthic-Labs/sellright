/**
 * Access-token handling for the affiliate dashboard (DD store/src/routes/
 * affiliate/index.tsx). The token travels in the URL FRAGMENT (#t=…), which the
 * browser never sends to the server, so it stays out of access logs and Referer
 * headers. Links emailed before the move carry it as ?t=…; those still work —
 * the token is moved into the fragment and the query param is stripped.
 */

export interface AffiliateTokenRead {
    token: string | null;
    /** Set only for a legacy ?t= link: the URL to history.replaceState to
     *  (fragment form, query param removed). */
    rewriteTo: string | null;
}

export function readAffiliateToken(href: string): AffiliateTokenRead {
    const url = new URL(href);
    const fromHash = new URLSearchParams(url.hash.replace(/^#/, '')).get('t')?.trim() || null;
    if (fromHash) return { token: fromHash, rewriteTo: null };

    const legacy = url.searchParams.get('t')?.trim() || null;
    if (!legacy) return { token: null, rewriteTo: null };
    url.searchParams.delete('t');
    url.hash = `t=${legacy}`;
    return { token: legacy, rewriteTo: url.toString() };
}
