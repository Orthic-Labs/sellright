import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';

const pathsToCheck = ['/', '/shop/', '/checkout/', '/account/'];
interface HeaderInfo {
	path: string;
	status: number;
	cacheControl: string | null;
	cfCacheStatus: string | null;
	routeClass: string | null;
	policyVersion: string | null;
	age: string | null;
	error?: string;
}

export default component$(() => {
        const headers = useSignal<HeaderInfo[]>([]);
        const loading = useSignal(false);
        const purgeStatus = useSignal<string | null>(null);
        const purgeError = useSignal<string | null>(null);
        const warming = useSignal(false);
        const adminToken = useSignal('');

	const loadHeaders = $(async () => {
		// Don't clear purgeStatus here, otherwise it hides our success messages when auto-refreshing
		purgeError.value = null;
		loading.value = true;
		try {
			const results: HeaderInfo[] = [];
			for (const path of pathsToCheck) {
				try {
					const response = await fetch(path, {
						method: 'GET',
						credentials: 'omit',
						cache: 'no-cache',
					});
					results.push({
						path,
						status: response.status,
						cacheControl: response.headers.get('cache-control'),
						cfCacheStatus: response.headers.get('cf-cache-status'),
						routeClass: response.headers.get('x-route-class'),
						policyVersion: response.headers.get('x-cache-policy-version'),
						age: response.headers.get('age'),
					});
				} catch (error) {
					results.push({
						path,
						status: 0,
						cacheControl: null,
						cfCacheStatus: null,
						routeClass: null,
						policyVersion: null,
						age: null,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			headers.value = results;
		} finally {
			loading.value = false;
		}
	});

	useVisibleTask$(({ cleanup }) => {
		loadHeaders();
		const id = setInterval(() => {
			loadHeaders();
		}, 15000);
		cleanup(() => clearInterval(id));
	});

	const handlePurgeClick = $(async () => {
		purgeStatus.value = null;
		purgeError.value = null;

		try {
	 	 	 const response = await fetch('/cache-admin/purge', {
	 	 	 	 method: 'POST',
	 	 	 	 headers: {
	 	 	 	 	 'Content-Type': 'application/json',
					 'x-cache-admin-token': adminToken.value,
	 	 	 	 },
	 	 	 });
			const json = await response.json().catch(() => null);
			if (!response.ok || !json?.success) {
				purgeError.value = json?.error || `HTTP ${response.status}`;
				return;
			}
			purgeStatus.value = `Purged ${Array.isArray(json.purged) ? json.purged.length : 0} urls`;
		} catch (error) {
			purgeError.value = error instanceof Error ? error.message : String(error);
		}
	});

	const handleWarmClick = $(async () => {
		purgeStatus.value = null;
		purgeError.value = null;
		warming.value = true; 
	 	 try { 
	 	 	 const response = await fetch('/cache-admin/warm', { 
	 	 	 	 method: 'POST', 
	 	 	 	 headers: { 
	 	 	 	 	 'Content-Type': 'application/json', 
					 'x-cache-admin-token': adminToken.value,
	 	 	 	 }, 
	 	 	 });
			
			const data = await response.json();
			
			if (response.ok && data.success) {
				// Extract region info to show user
				const activeRegions = data.edge?.map((e: any) => e.region).join(', ') || 'none';
				purgeStatus.value = `Warming complete! Edge regions triggered & shut down: ${activeRegions}`;
				await loadHeaders();
			} else {
				purgeError.value = data.error || 'Failed to warm cache';
			}
		} catch (error) {
			purgeError.value = error instanceof Error ? error.message : String(error);
		} finally {
			warming.value = false;
		}
	});

	return (
		<div
			style={{
				minHeight: '100vh',
				backgroundColor: '#ffffff',
				padding: '4rem 0 3rem',
				color: '#111111',
			}}
		>
			<div
				style={{
					maxWidth: '960px',
					margin: '0 auto',
					padding: '0 1rem',
					fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
				}}
			>
				<h1 style={{ fontSize: '1.75rem', marginBottom: '0.75rem' }}>Cache Debug</h1>
				<label
					style={{
						display: 'block',
						marginBottom: '1rem',
						fontSize: '0.85rem',
						color: '#333',
					}}
				>
					<span style={{ display: 'block', marginBottom: '0.35rem' }}>Admin token</span>
					<input
						type="password"
						value={adminToken.value}
						onInput$={(_, el) => {
							adminToken.value = el.value;
						}}
						style={{
							width: '100%',
							maxWidth: '360px',
							padding: '0.45rem 0.6rem',
							borderRadius: '4px',
							border: '1px solid #ccc',
							color: '#111',
							background: '#fff',
						}}
					/>
				</label>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						gap: '0.75rem',
						marginBottom: '1.25rem',
					}}
				>
					<div style={{ display: 'flex', gap: '0.5rem' }}>
						<button
							type="button"
							onClick$={loadHeaders}
							disabled={loading.value}
							style={{
								padding: '0.4rem 0.75rem',
								borderRadius: '4px',
								border: '1px solid #ccc',
								backgroundColor: loading.value ? '#f0f0f0' : '#f8f8f8',
								color: '#111',
								cursor: loading.value ? 'default' : 'pointer',
								fontSize: '0.85rem',
							}}
						>
							{loading.value ? 'Refresh…' : 'Refresh'}
						</button>
						<button
							type="button"
							onClick$={handleWarmClick}
							disabled={warming.value}
							style={{
								padding: '0.4rem 0.75rem',
								borderRadius: '4px',
								border: '1px solid #ccc',
								backgroundColor: warming.value ? '#f0f0f0' : '#f8f8f8',
								color: '#111',
								cursor: warming.value ? 'default' : 'pointer',
								fontSize: '0.85rem',
							}}
						>
							{warming.value ? 'Warming…' : 'Warm'}
						</button>
						<button
							type="button"
							onClick$={handlePurgeClick}
							style={{
								padding: '0.4rem 0.75rem',
								borderRadius: '4px',
								border: '1px solid #ccc',
								backgroundColor: '#111',
								color: '#fff',
								cursor: 'pointer',
								fontSize: '0.85rem',
							}}
						>
							Clear
						</button>
					</div>
				</div>

				<section style={{ marginBottom: '2rem' }}>
					{loading.value && <p style={{ color: '#444', marginBottom: '0.4rem' }}>Refreshing…</p>}
					<table
						style={{
							width: '100%',
							borderCollapse: 'collapse',
							fontSize: '0.9rem',
							backgroundColor: '#fff',
							border: '1px solid #e0e0e0',
							borderRadius: '6px',
							overflow: 'hidden',
						}}
					>
						<thead style={{ backgroundColor: '#f4f4f4' }}>
							<tr>
								<th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.5rem', color: '#111' }}>Path</th>
								<th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.5rem', color: '#111' }}>Status</th>
								<th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.5rem', color: '#111' }}>cf-cache-status</th>
								<th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.5rem', color: '#111' }}>Cache-Control</th>
								<th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.5rem', color: '#111' }}>x-route-class</th>
								<th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.5rem', color: '#111' }}>policy</th>
								<th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.5rem', color: '#111' }}>age</th>
								<th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '0.5rem', color: '#111' }}>Error</th>
							</tr>
						</thead>
						<tbody>
							{headers.value.map((h) => (
								<tr key={h.path}>
									<td style={{ borderBottom: '1px solid #eee', padding: '0.5rem', color: '#111' }}>{h.path}</td>
									<td style={{ borderBottom: '1px solid #eee', padding: '0.5rem', color: '#111' }}>{h.status}</td>
									<td style={{ borderBottom: '1px solid #eee', padding: '0.5rem', color: '#111' }}>{h.cfCacheStatus || '—'}</td>
									<td style={{ borderBottom: '1px solid #eee', padding: '0.5rem', color: '#111' }}>{h.cacheControl || '—'}</td>
									<td style={{ borderBottom: '1px solid #eee', padding: '0.5rem', color: '#111' }}>{h.routeClass || '—'}</td>
									<td
										style={{
											borderBottom: '1px solid #eee',
											padding: '0.5rem',
											color: '#111',
										}}
									>
										{h.policyVersion || '—'}
									</td>
									<td style={{ borderBottom: '1px solid #eee', padding: '0.5rem', color: '#111' }}>{h.age || '—'}</td>
									<td style={{ borderBottom: '1px solid #eee', padding: '0.5rem', color: '#b00020' }}>{h.error || ''}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
				{purgeStatus.value && <p style={{ color: '#0a7b34' }}>{purgeStatus.value}</p>}
				{purgeError.value && <p style={{ color: '#b00020' }}>{purgeError.value}</p>}
			</div>
		</div>
	);
});
