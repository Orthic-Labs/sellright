/**
 * Consumer-contract test for the affiliate dashboard provider — proves it
 * calls the SellRight REST route (GET /v1/shop/affiliate?t=...) through the
 * typed `~/sellright/client` (never the old Vendure GraphQL
 * affiliateStatsByToken query, and never a hand-rolled fetch with its own
 * copy of the store-resolution logic), and reshapes the backend response
 * into the AffiliateStatsResult the /affiliate page renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAffiliateStatsByToken } from './affiliate';

type FetchCall = { url: string; init: RequestInit };
const calls: FetchCall[] = [];
let queue: Promise<Response>[] = [];

const respond = (status: number, body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
	calls.length = 0;
	queue = [];
	// The typed client (openapi-fetch) calls `fetch(new Request(...))` — the
	// first argument is a `Request` instance, not a bare URL string, so the
	// URL has to be read off `.url`, not `String(input)` (which would give
	// "[object Request]").
	vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		calls.push({ url, init: init ?? {} });
		const next = queue.shift();
		if (!next) throw new Error('fetch called with no queued response');
		return next;
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const TOKEN = 'aabbccddeeff00112233445566778899';

describe('fetchAffiliateStatsByToken', () => {
	it('calls the REST route with the token as a query param, not GraphQL', async () => {
		queue.push(respond(200, { success: true, email: 'aff@example.test', couponCode: 'AFF10', rate: 0.1, totals: { earnedUsd: 10, paidUsd: 0, owedUsd: 10, orderCount: 1, rangeStart: null, rangeEnd: null }, orders: [], topProducts: [], settles: [] }));
		const result = await fetchAffiliateStatsByToken(TOKEN);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain('/v1/shop/affiliate?t=');
		expect(calls[0].url).toContain(TOKEN);
		expect(calls[0].url).not.toContain('shop-api');
		expect(result.success).toBe(true);
		expect(result.email).toBe('aff@example.test');
		expect(result.totals?.earnedUsd).toBe(10);
	});

	it('maps a 404 (unknown token) to a graceful failure, no throw', async () => {
		queue.push(respond(404, { error: 'invalid affiliate link' }));
		const result = await fetchAffiliateStatsByToken(TOKEN);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it('rejects a too-short token before ever calling fetch', async () => {
		const result = await fetchAffiliateStatsByToken('short');
		expect(calls).toHaveLength(0);
		expect(result.success).toBe(false);
	});
});
