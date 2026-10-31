// ADR-0001 DP-1/DP-2: the shell's Product JSON-LD carries no offers. When the page's loader says its values are pending (SHELL_CACHE=1),
// the browser reads the live offers (the API's per-request price and availability, no-store) once per view and writes them into the
// Product JSON-LD script. Off (values in the loader): no read.
import { $, useComputed$ } from '@qwik.dev/core';
import { readProductOffers } from '~/platform/product';
import { fillJsonLdOffers } from '~/platform/product-jsonld-light';
import { useLiveRead } from '~/platform/live-values';

/** `slug`: the product of the view; `pending`: the shell carries no offers. */
export function useJsonLdOffersFill(slug: string, pending: boolean): void {
	const key = useComputed$(() => (pending && slug ? slug : null));
	useLiveRead<number>(
		$(async () => fillLiveOffers(await readProductOffers(slug))),
		key,
	);
}

/** Writes live offers into the page's Product JSON-LD (the PDPs read them with their live values in one request, lane 11). */
export function fillLiveOffers(offers: Record<string, unknown> | null | undefined): number | null {
	if (!offers || typeof document === 'undefined') return null;
	const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
	const filled = canonical && typeof offers.url === 'string' ? { ...offers, url: canonical } : offers;
	return fillJsonLdOffers(document, filled);
}
