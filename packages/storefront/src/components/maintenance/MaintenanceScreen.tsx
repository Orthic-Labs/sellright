import { component$ } from '@qwik.dev/core';

interface MaintenanceScreenProps {
	storeName: string;
}

/**
 * WS-E: rendered instead of the real storefront chrome while
 * GET /v1/maintenance reports maintenance: true (the appliance is mid
 * update). Distinct from ComingSoon (an unpublished store) — this is a
 * temporary, expected-to-resolve-in-minutes state, so the copy says so.
 */
export default component$<MaintenanceScreenProps>(({ storeName }) => {
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
			<p style={{ color: '#71717a' }}>We&apos;ll be back soon. The store is undergoing brief maintenance.</p>
		</div>
	);
});
