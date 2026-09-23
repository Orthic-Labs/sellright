import { component$, useStyles$ } from '@qwik.dev/core';
import { QwikRouterProvider, RouterOutlet, ServiceWorkerRegister } from '@qwik.dev/router';
import { Head } from './components/head/head';

import globalStyles from './global.css?inline';

interface RootProps {
	nonce?: string;
}

export default component$<RootProps>(({ nonce }) => {
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
				<ServiceWorkerRegister />
			</body>
		</QwikRouterProvider>
	);
});
