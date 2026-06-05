import { component$, useStyles$ } from '@qwik.dev/core';
import { type DocumentHead, routeLoader$ } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';
import { fetchAffiliateStatsByToken, type AffiliateStatsResult } from '~/providers/shop/affiliate/affiliate';

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtPeriod = (start: string, end: string) => {
    const s = new Date(start);
    const e = new Date(end);
    const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
    const sFmt = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
    const eFmt = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${sFmt} – ${eFmt}`;
};

const relativeDate = (iso: string): string => {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diffSec = Math.max(0, Math.floor((now - then) / 1000));
    if (diffSec < 45) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    const diffWk = Math.floor(diffDay / 7);
    if (diffDay < 30) return `${diffWk}w ago`;
    const diffMo = Math.floor(diffDay / 30);
    if (diffMo < 12) return `${diffMo} mo ago`;
    const diffYr = Math.floor(diffDay / 365);
    return `${diffYr} yr ago`;
};

export const useAffiliateData = routeLoader$(async ({ url }) => {
    const token = url.searchParams.get('t')?.trim() ?? null;
    if (!token) return { token: null, result: null };
    const result = await fetchAffiliateStatsByToken(token);
    return { token, result };
});

export default component$(() => {
    useStyles$(`
        :root .aff-scope { --aff-copper: #B87333; --aff-ink: #111110; --aff-muted: #5a5a55; --aff-bg: #F7F2EA; --aff-surface: #ffffff; --aff-border: #e8e6e0; --aff-soft: #f4f1ea; }
        @keyframes aff-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

        .aff-scope { background: var(--aff-bg); padding: 2rem 1.25rem 4rem; font-family: var(--font-body), 'IBM Plex Sans', system-ui, sans-serif; color: var(--aff-ink); animation: aff-fade-in 240ms ease-out; }
        .aff-page { max-width: 1024px; margin: 0 auto; }

        .aff-kicker { font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--aff-muted); margin-bottom: 18px; display: flex; align-items: center; gap: 10px; }
        .aff-kicker::before { content: ''; display: inline-block; width: 28px; height: 1px; background: var(--aff-copper); }

        .aff-h1 { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(2rem, 5vw, 3rem); line-height: 1.05; font-weight: 600; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
        .aff-meta { color: var(--aff-muted); font-size: 14px; margin-bottom: 2.75rem; display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
        .aff-pill { font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-size: 12px; letter-spacing: 0.06em; padding: 4px 10px; background: var(--aff-ink); color: #fff; border-radius: 2px; }

        .aff-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 3rem; }
        .aff-card { background: var(--aff-surface); border: 1px solid var(--aff-border); border-radius: 8px; padding: 1.5rem 1.75rem; }
        .aff-card-hero { background: var(--aff-surface); border: 1px solid var(--aff-copper); border-radius: 8px; padding: 1.5rem 1.75rem; box-shadow: 0 1px 0 rgba(184,115,51,0.08); }
        .aff-card .label, .aff-card-hero .label { font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--aff-muted); margin-bottom: 12px; }
        .aff-card .value { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(2rem, 4.5vw, 2.625rem); line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; color: var(--aff-ink); }
        .aff-card-hero .value { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(2.25rem, 5vw, 3rem); line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; color: var(--aff-copper); }

        .aff-section-h { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: 1.625rem; font-weight: 600; margin: 3rem 0 0.875rem; letter-spacing: -0.005em; }

        .aff-table-wrap { background: var(--aff-surface); border: 1px solid var(--aff-border); border-radius: 8px; overflow: hidden; }
        .aff-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .aff-table th { padding: 14px 18px; text-align: left; border-bottom: 1px solid var(--aff-border); background: var(--aff-soft); font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--aff-muted); font-weight: 500; white-space: nowrap; }
        .aff-table td { padding: 13px 18px; border-bottom: 1px solid var(--aff-border); vertical-align: middle; }
        .aff-table tr:last-child td { border-bottom: none; }
        .aff-table td.num { text-align: right; font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .aff-table td.mono { font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-size: 13px; }
        .aff-table td.muted { color: var(--aff-muted); font-size: 13px; }
        .aff-table td.commission { color: var(--aff-copper); }

        .aff-footnote { margin-top: 3rem; color: var(--aff-muted); font-size: 13px; line-height: 1.65; padding-top: 1.5rem; border-top: 1px solid var(--aff-border); }
        .aff-footnote a { color: var(--aff-copper); text-decoration: none; }
        .aff-footnote a:hover { text-decoration: underline; }

        .aff-empty { text-align: center; padding: 5rem 1.5rem; }
        .aff-empty-h { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: 1.875rem; font-weight: 500; margin-bottom: 12px; color: var(--aff-ink); }
        .aff-empty-p { color: var(--aff-muted); font-size: 15px; line-height: 1.6; max-width: 28rem; margin: 0 auto; }

        @media (max-width: 720px) {
            .aff-scope { padding: 1.5rem 1rem 3rem; }
            .aff-cards { grid-template-columns: 1fr; }
            .aff-table th, .aff-table td { padding: 11px 12px; }
        }
    `);

    const data = useAffiliateData();

    // No token: show a quiet "use the link from your email" prompt.
    if (!data.value.token) {
        return (
            <div class="aff-scope">
                <div class="aff-page">
                    <div class="aff-empty">
                        <div class="aff-kicker">Affiliate dashboard</div>
                        <h1 class="aff-empty-h">Use the link from your welcome email.</h1>
                        <p class="aff-empty-p">
                            If you've lost it, just reply to that email and we'll send a new one.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // Token present but invalid / server error.
    const result = data.value.result as AffiliateStatsResult | null;
    if (!result?.success) {
        return (
            <div class="aff-scope">
                <div class="aff-page">
                    <div class="aff-empty">
                        <div class="aff-kicker">Affiliate dashboard</div>
                        <h1 class="aff-empty-h">{result?.error ?? 'Could not load stats.'}</h1>
                        <p class="aff-empty-p">
                            Reply to your welcome email and we'll resend your access link.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const r = result;
    const totals = r.totals!;
    const orders = r.orders ?? [];
    const topProducts = r.topProducts ?? [];
    const settles = r.settles ?? [];
    const ratePct = Math.round((r.rate ?? 0) * 100);

    return (
        <div class="aff-scope">
            <div class="aff-page">
                <div class="aff-kicker">Affiliate dashboard</div>
                <h1 class="aff-h1">{r.email}</h1>
                <div class="aff-meta">
                    <span class="aff-pill">{r.couponCode}</span>
                    <span>{ratePct}% commission · payouts monthly</span>
                </div>

                <div class="aff-cards">
                    <div class="aff-card">
                        <div class="label">Total earned</div>
                        <div class="value">{fmt.format(totals.earnedUsd)}</div>
                    </div>
                    <div class="aff-card">
                        <div class="label">Total paid</div>
                        <div class="value">{fmt.format(totals.paidUsd)}</div>
                    </div>
                    <div class="aff-card-hero">
                        <div class="label">Currently owed</div>
                        <div class="value">{fmt.format(totals.owedUsd)}</div>
                    </div>
                </div>

                {topProducts.length > 0 && (
                    <>
                        <h2 class="aff-section-h">Your top sellers</h2>
                        <div class="aff-table-wrap">
                            <table class="aff-table">
                                <thead>
                                    <tr>
                                        <th>Product</th>
                                        <th>SKU</th>
                                        <th style="text-align:right">Qty</th>
                                        <th style="text-align:right">Revenue</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {topProducts.map((p) => (
                                        <tr key={p.sku}>
                                            <td>{p.name}</td>
                                            <td class="mono muted">{p.sku}</td>
                                            <td class="num">{p.qtySold}</td>
                                            <td class="num">{fmt.format(p.revenueUsd)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}

                <h2 class="aff-section-h">
                    Orders{' '}
                    <span style="font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-size: 13px; color: var(--aff-muted); letter-spacing: 0.04em; font-weight: 400;">
                        ({totals.orderCount})
                    </span>
                </h2>
                {orders.length === 0 ? (
                    <div class="aff-table-wrap" style="padding: 3rem 1.5rem; text-align: center; color: var(--aff-muted);">
                        No qualifying orders yet — share your code and they'll show up here.
                    </div>
                ) : (
                    <div class="aff-table-wrap">
                        <table class="aff-table">
                            <thead>
                                <tr>
                                    <th>Order</th>
                                    <th>Date</th>
                                    <th style="text-align:right">Items</th>
                                    <th style="text-align:right">Subtotal</th>
                                    <th style="text-align:right">Commission</th>
                                    <th>State</th>
                                </tr>
                            </thead>
                            <tbody>
                                {orders.map((o) => (
                                    <tr key={o.redactedCode + o.placedAt}>
                                        <td class="mono">…{o.redactedCode}</td>
                                        <td class="mono muted" title={fmtDate(o.placedAt)}>{relativeDate(o.placedAt)}</td>
                                        <td class="num">{o.itemCount}</td>
                                        <td class="num">{fmt.format(o.subtotalUsd)}</td>
                                        <td class="num commission">{fmt.format(o.commissionUsd)}</td>
                                        <td class="muted" style="font-size: 12.5px;">{o.state}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <h2 class="aff-section-h">
                    Payouts{' '}
                    <span style="font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-size: 13px; color: var(--aff-muted); letter-spacing: 0.04em; font-weight: 400;">
                        ({settles.length})
                    </span>
                </h2>
                {settles.length === 0 ? (
                    <div class="aff-table-wrap" style="padding: 3rem 1.5rem; text-align: center; color: var(--aff-muted);">
                        No payouts yet — first one will land at end of next month.
                    </div>
                ) : (
                    <div class="aff-table-wrap">
                        <table class="aff-table">
                            <thead>
                                <tr>
                                    <th>Settled</th>
                                    <th>Period</th>
                                    <th style="text-align:right">Amount</th>
                                    <th>Reference</th>
                                </tr>
                            </thead>
                            <tbody>
                                {settles.map((s) => (
                                    <tr key={s.settledAt + (s.txRef ?? '')}>
                                        <td class="mono muted" title={fmtDate(s.settledAt)}>{relativeDate(s.settledAt)}</td>
                                        <td class="mono muted">{s.periodStartAt ? fmtPeriod(s.periodStartAt, s.periodEndAt) : `Up to ${fmtDate(s.periodEndAt)}`}</td>
                                        <td class="num commission">{fmt.format(s.amountUsd)}</td>
                                        <td class="mono muted">{s.txRef ?? '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <p class="aff-footnote">
                    Refunded or cancelled orders are not shown. Commission is 10% of the post-discount, pre-tax product subtotal — shipping and tax are excluded. Payouts go out monthly. Lost your link? <a href="mailto:info@damneddesigns.com">Email us</a> and we'll resend it.
                </p>
            </div>
        </div>
    );
});

export const head: DocumentHead = createSEOHead({
    title: 'Affiliate dashboard — Damned Designs',
    description: 'Damned Designs affiliate stats.',
    noindex: true,
});
