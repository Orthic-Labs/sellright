import { component$ } from '@qwik.dev/core';
import { QwikRouterProvider, RouterOutlet, ServiceWorkerRegister } from '@qwik.dev/router';
import { Head } from './components/head/head';
import { COMMERCE_FLOW } from './platform/license/flow-env';
import { LicenseRoot } from './platform/license/root';

// #360: a stylesheet import, not ?inline + useStyles$: the client build emits it as a content-hashed /build/*.css (immutable,
// precompressed) and Qwik's manifest injections link it first in every page's <head>, where the inline <style q:style> sat
// (same cascade position). A license-flow build resolves this import to nothing (vite.config.ts): LicenseRoot has license.css.
import './global.css';

interface RootProps {
	nonce?: string;
	/** #375: Cloudflare's visitor country for the GTM loader (head-analytics.ts). */
	country?: string;
}

const CartRoot = component$<RootProps>(({ nonce, country }) => {
	return (
		<QwikRouterProvider>
			<Head nonce={nonce} country={country} />
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
