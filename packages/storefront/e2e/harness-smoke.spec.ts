import { test, expect } from './fixtures';
import { CATALOG_DIR, TAP_URL } from './support/env.mjs';
import { AdminApi, SKU } from './support/api';
import { apiLog } from './support/api-log';
import { currentGeneration, generationNames, setOnHand, waitForNewGeneration } from './support/stock';

/**
 * A5 gate (c): the parameterised harness works end to end. Needs E2E_API_TAP=1 and E2E_CATALOG_DIR=<dir> (so the real
 * publisher is on and the storefront server is told the same directory). Without them it is SKIPPED, which the runner
 * (support/run-parity.sh) and the gate commands treat as missing coverage, never as a pass. Reader behaviour is NOT asserted here (A4 / O2): this only proves the harness can observe it.
 */
test.skip(!apiLog.enabled || !CATALOG_DIR, 'harness-smoke needs E2E_API_TAP=1 and E2E_CATALOG_DIR: did not run, missing coverage (a skip is never a pass)');

test('a stock change through the admin API publishes a new generation and is visible at the API tap', async ({ api }) => {
	const before = currentGeneration();
	const mark = apiLog.mark();
	// Send the admin write through the tap on purpose, so the stock-change request itself is in api-requests.jsonl.
	const tapped = new AdminApi(api.token, undefined, TAP_URL);
	const live = await api.stock(SKU.mug);
	const { variantId } = live;
	await tapped.patch(`/variants/${variantId}/stock`, { onHand: live.onHand + 1 });
	try {
		const after = await waitForNewGeneration(before?.name ?? null);
		expect(after.name).toMatch(/^generations\/[0-9a-f-]{36}$/);
		expect(after.marker).toMatchObject({ source: 'sellright', storeSlug: 'e2e', generation: after.name.split('/')[1] });
		expect(generationNames()).toContain(after.name.split('/')[1]);

		const calls = await apiLog.since(mark, new RegExp(`^/v1/admin/variants/${variantId}/stock$`));
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'PATCH', status: 200, origin: 'server' });
	} finally {
		await setOnHand(api, SKU.mug, live.onHand); // restore the fixture
	}
});
