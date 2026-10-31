// Lane 11: the branded product page's ONE live read on load (ADR-0001). It used to send two server$ calls on the same load, the detail
// (live prices) and the Product JSON-LD offers; this reads both on the server in parallel and answers in one no-store request at low
// fetch priority, so neither competes with the LCP image or the LOCKED live stock read (which the controller starts first).
import { server$ } from '@qwik.dev/router';
import { noStore } from '~/platform/shell-render';
import { hasView } from '~/platform/gateway';
import { buildBrandProductDetail, type BrandProductDetail } from '~/platform/product-detail';
import { LIVE_READ_FETCH, liveOffersOf } from '~/platform/product';

const SAFE_SLUG = /^[a-z0-9][a-z0-9\-_]*$/;

export interface BrandProductLive {
	/** The detail with its live prices, or null on failure (the view keeps its pending prices). */
	detail: BrandProductDetail | null;
	/** The live JSON-LD offers, or null. */
	offers: Record<string, unknown> | null;
}

/** The branded product page's live values in the browser: the same build for the slug and the live offers, per request, no-store. */
export const readBrandProductLive = server$(async function (slug: string): Promise<BrandProductLive | null> {
	noStore(this);
	if (!hasView('route.product') || typeof slug !== 'string' || !SAFE_SLUG.test(slug)) return null;
	const [detail, offers] = await Promise.all([buildBrandProductDetail(slug).catch(() => 'unavailable' as const), liveOffersOf(slug)]);
	return { detail: detail === 'unavailable' ? null : detail, offers };
}, LIVE_READ_FETCH);
