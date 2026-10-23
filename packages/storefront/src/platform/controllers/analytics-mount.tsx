// Mounted by the layout only when head.json declares analytics: starts the conversion subscriber once the document is ready, and
// records the landing attribution (UTM + oppref, consent-gated, last touch) of every URL the shopper reaches, SPA navigations included.
import { component$, useVisibleTask$ } from '@qwik.dev/core';
import { useLocation } from '@qwik.dev/router';
import { captureAttribution } from '~/sellright/attribution';
import { startConversion } from './conversion';

export const AnalyticsMount = component$(() => {
	const location = useLocation();
	useVisibleTask$(
		({ track }) => {
			track(() => location.url.href);
			startConversion();
			captureAttribution(window.location.href);
		},
		{ strategy: 'document-ready' },
	);
	return null;
});
