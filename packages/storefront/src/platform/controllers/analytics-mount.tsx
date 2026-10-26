// Mounted by the layout only when head.json declares analytics: starts the conversion subscriber once the document is ready, and
// records the landing attribution (UTM + oppref, consent-gated, last touch) of every URL the shopper reaches, SPA navigations included.
// #375: for a brand with the OpenAI pixel (head.json analytics.adPlatforms), it also publishes hashed user data (user-data.ts) on every
// page and whenever the signed-in customer or the checkout's contact/address details change (debounced: analytics only, never stock).
import { component$, useContext, useVisibleTask$ } from '@qwik.dev/core';
import { useLocation } from '@qwik.dev/router';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { captureAttribution } from '~/sellright/attribution';
import { startConversion } from './conversion';
import { publishUserData, userDataEnabled } from './user-data';

export const AnalyticsMount = component$(() => {
	const location = useLocation();
	const appState = useContext(APP_STATE);
	useVisibleTask$(
		({ track }) => {
			track(() => location.url.href);
			startConversion();
			captureAttribution(window.location.href);
		},
		{ strategy: 'document-ready' },
	);
	useVisibleTask$(
		({ track, cleanup }) => {
			const c = track(() => ({ ...appState.customer }));
			const a = track(() => ({ ...appState.shippingAddress }));
			track(() => location.url.href);
			if (!userDataEnabled()) return;
			const timer = setTimeout(() => {
				void publishUserData({
					customerId: c.id && c.id !== CUSTOMER_NOT_DEFINED_ID ? c.id : null,
					email: c.emailAddress,
					phone: a.phoneNumber || c.phoneNumber,
					firstName: c.firstName,
					lastName: c.lastName,
					fullName: a.fullName,
					country: a.countryCode,
					city: a.city,
					region: a.province,
					postalCode: a.postalCode,
				});
			}, 600);
			cleanup(() => clearTimeout(timer));
		},
		{ strategy: 'document-ready' },
	);
	return null;
});
