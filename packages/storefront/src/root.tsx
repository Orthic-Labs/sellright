import { component$, useStyles$ } from '@qwik.dev/core';
import { QwikRouterProvider, RouterOutlet, ServiceWorkerRegister } from '@qwik.dev/router';
import { Head } from './components/head/head';
import { COMMERCE_FLOW } from './platform/license/flow-env';
import { LicenseRoot } from './platform/license/root';

import globalStyles from './global.css?inline';

interface RootProps {
	nonce?: string;
}

const CartRoot = component$<RootProps>(({ nonce }) => {
	useStyles$(globalStyles);

	return (
		<QwikRouterProvider>
			<Head nonce={nonce} />
			<body lang="en">
				<a
					href="#main-content"
					class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:bg-white focus:text-black focus:px-4 focus:py-2 focus:rounded"
				>
					Skip to main content
				</a>
				<RouterOutlet />
				<ServiceWorkerRegister nonce={nonce} />
			</body>
		</QwikRouterProvider>
	);
});

// The license commerce flow (VITE_SR_COMMERCE_FLOW=license) renders its own document: src/platform/license/root.tsx.
export default COMMERCE_FLOW === 'license' ? LicenseRoot : CartRoot;
