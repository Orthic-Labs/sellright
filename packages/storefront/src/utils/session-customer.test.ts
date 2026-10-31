import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { SESSION_ENDPOINT, anonymousCustomer, fetchSessionCustomer, nextCustomer, pageSessionCustomer, resetPageSessionForTest } from './session-customer';

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const ada = { id: 'c1', firstName: 'Ada', lastName: 'L', emailAddress: 'ada@example.com' };

describe('fetchSessionCustomer (browser read of the signed-in customer)', () => {
	it('reads the no-store endpoint fresh on every call', async () => {
		const f = reply(200, { customer: ada });
		await fetchSessionCustomer(f);
		await fetchSessionCustomer(f);
		expect(f).toHaveBeenCalledTimes(2);
		expect(f).toHaveBeenCalledWith(SESSION_ENDPOINT, expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }));
	});

	it('maps signed-in, anonymous and failed reads', async () => {
		expect(await fetchSessionCustomer(reply(200, { customer: ada }))).toEqual({ status: 'signed-in', customer: ada });
		expect(await fetchSessionCustomer(reply(200, { customer: null }))).toEqual({ status: 'anonymous' });
		expect(await fetchSessionCustomer(reply(503, { error: 'session_unavailable' }))).toEqual({ status: 'unknown' });
		expect(await fetchSessionCustomer(reply(200, {}))).toEqual({ status: 'unknown' });
		expect(await fetchSessionCustomer(reply(200, { customer: { id: CUSTOMER_NOT_DEFINED_ID, firstName: '', lastName: '' } }))).toEqual({ status: 'unknown' });
		expect(await fetchSessionCustomer(vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toEqual({ status: 'unknown' });
	});
});

describe('nextCustomer (what the layout writes into appState.customer)', () => {
	it('keeps page-added fields for the same customer and drops them for another', () => {
		const current = { ...ada, phoneNumber: '+1 555', title: 'Dr' };
		expect(nextCustomer(current, { status: 'signed-in', customer: { ...ada, firstName: 'Ada2' } })).toEqual({ ...current, firstName: 'Ada2' });
		const other = { id: 'c9', firstName: 'Z', lastName: 'Y', emailAddress: 'z@example.com' };
		expect(nextCustomer(current, { status: 'signed-in', customer: other })).toEqual(other);
	});

	it('signs out a signed-in page, and leaves an anonymous page or a failed read alone', () => {
		expect(nextCustomer(ada, { status: 'anonymous' })).toEqual(anonymousCustomer());
		expect(nextCustomer(anonymousCustomer(), { status: 'anonymous' })).toBeNull();
		expect(nextCustomer(ada, { status: 'unknown' })).toBeNull();
	});
});

describe('#412: one GET /api/session/ per page load', () => {
	afterEach(() => { vi.unstubAllGlobals(); resetPageSessionForTest(); });
	const stub = () => { const f = reply(200, { customer: ada }); vi.stubGlobal('fetch', f); return f; };

	it('the checkout takes the layout\'s read for this page (in flight or settled) instead of sending its own', async () => {
		const f = stub();
		const layout = fetchSessionCustomer();
		expect(await pageSessionCustomer()).toEqual({ status: 'signed-in', customer: ada });
		await layout;
		expect(await pageSessionCustomer()).toEqual({ status: 'signed-in', customer: ada });
		expect(f).toHaveBeenCalledTimes(1);
	});

	it('the checkout asked first: the layout joins that read once, then reads fresh on the next page', async () => {
		const f = stub();
		const checkout = pageSessionCustomer();
		const layout = fetchSessionCustomer();
		expect(layout).toBe(checkout);
		await layout;
		expect(f).toHaveBeenCalledTimes(1);
		await fetchSessionCustomer(); // a client navigation: always a new read
		expect(f).toHaveBeenCalledTimes(2);
		await pageSessionCustomer(); // ... which the page then takes
		expect(f).toHaveBeenCalledTimes(2);
	});
});
