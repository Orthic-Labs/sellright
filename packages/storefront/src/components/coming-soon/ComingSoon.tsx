import { component$ } from '@qwik.dev/core';

interface ComingSoonProps {
	storeName: string;
}

/**
 * WS-C private-preview gate (plan §1.5): shown instead of the real storefront
 * chrome when a store is unpublished and the visitor has no valid preview
 * token. Deliberately reveals nothing about the store beyond a generic
 * name/message — an unpublished store must be indistinguishable from an
 * unknown one to an outside observer (the API's /v1/shop/identity 404s the
 * same way for both).
 */
export default component$<ComingSoonProps>(({ storeName }) => {
	return (
		<div
			style={{
				minHeight: '100vh',
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				textAlign: 'center',
				padding: '2rem',
				fontFamily: 'system-ui, sans-serif',
			}}
		>
			<h1 style={{ fontSize: '1.75rem', marginBottom: '0.5rem' }}>{storeName}</h1>
			<p style={{ color: '#71717a' }}>This store is being set up. Check back soon.</p>
		</div>
	);
});
