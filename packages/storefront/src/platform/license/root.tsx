// The document of the license flow (VITE_SR_COMMERCE_FLOW=license): its own minimal head and stylesheet (license.css, which
// imports the brand's src/brand/license.css), no cart, header or footer chrome. src/root.tsx renders it instead of the cart root.
import { component$, useStyles$ } from '@qwik.dev/core';
import { QwikRouterProvider, RouterOutlet, ServiceWorkerRegister, useDocumentHead, useLocation } from '@qwik.dev/router';
import licenseStyles from './license.css?inline';

/** The route's `head` export: title, the route's meta (robots), the canonical URL of the request. */
export const LicenseHead = component$(() => {
	const head = useDocumentHead();
	const loc = useLocation();
	return (
		<>
			<title>{head.title}</title>
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<link rel="canonical" href={loc.url.href} />
			{head.meta.map((m) => (
				<meta key={m.key} {...m} />
			))}
			{head.links.map((l) => (
				<link key={l.key} {...l} />
			))}
		</>
	);
});

export const LicenseRoot = component$<{ nonce?: string }>(({ nonce }) => {
	useStyles$(licenseStyles);
	return (
		<QwikRouterProvider>
			<head>
				<meta charset="utf-8" />
				<LicenseHead />
			</head>
			<body lang="en">
				<RouterOutlet />
				<ServiceWorkerRegister nonce={nonce} />
			</body>
		</QwikRouterProvider>
	);
});
